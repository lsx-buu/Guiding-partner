import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDshImGateway } from '../../../src/channels/shared/dsh-im-gateway.mjs';
import { createCompanionCore } from '../src/runtime.mjs';
import { createStickerCatalog } from '../src/sticker.mjs';

function gatewayFixture({ capabilities = { text: true, image: true, sticker: true } } = {}) {
  const sent = [];
  const { gateway, registry } = createDshImGateway();
  registry.registerAdapter('memory', {
    capabilities,
    health: { status: 'online' },
    async send(_route, message, options) {
      sent.push({ message, options });
      return { schemaVersion: 1, deliveryOutcome: 'sent', deliveryId: options.idempotencyKey };
    },
  });
  const route = registry.upsertTrustedRoute({
    channel: 'memory', botId: 'bot', kind: 'direct', conversationId: 'owner',
    ownerId: 'owner', adapterId: 'memory',
    verification: { kind: 'configured-owner', verifiedAt: '2026-08-01T00:00:00.000Z' },
  });
  return { gateway, registry, route, sent };
}

async function stickerFixture(t, { cooldownMs = 86_400_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-companion-stickers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  const imagePath = join(root, 'assets', 'happy.png');
  await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const manifestPath = join(root, 'stickers.json');
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    stickers: [{
      id: 'happy', file: 'assets/happy.png', emotion: 'happy', intensity: 1,
      tags: [], contexts: ['morning'],
    }],
  }));
  return {
    imagePath,
    catalog: await createStickerCatalog({ rootDir: root, manifestPath, cooldownMs }),
  };
}

test('concurrent ticks create one durable candidate plan and send once', async () => {
  const fx = gatewayFixture({ capabilities: { text: true } });
  let current = '2026-08-24T00:00:00.000Z';
  let generatorCalls = 0;
  const core = await createCompanionCore({
    databasePath: ':memory:', gateway: fx.gateway, now: () => current,
    generator: { async generate() { generatorCalls += 1; return { bubbles: [{ text: '早呀，昨晚睡得好吗？' }] }; } },
  });
  await core.ensureCandidates('owner');
  const morning = core.listCandidates('owner').find((item) => item.window_kind === 'morning');
  current = new Date(Date.parse(morning.scheduled_at) + 1_000).toISOString();
  const [left, right] = await Promise.all([core.tick(), core.tick()]);
  assert.deepEqual(left, right);
  assert.equal(generatorCalls, 1);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0].message.text, '早呀，昨晚睡得好吗？');
  assert.equal(core.listCandidates('owner').length, 3);
  const finished = core.listCandidates('owner').find((item) => item.candidate_id === morning.candidate_id);
  assert.equal(finished.status, 'planned');
  const planId = JSON.parse(finished.decision_json).planId;
  assert.equal(core.inspectPlan(planId).status, 'sent');
  await core.close();
});

test('topic candidate searches with abstract memory and deletes its source when memory is forgotten', async () => {
  const fx = gatewayFixture({ capabilities: { text: true } });
  let current = '2026-08-24T03:00:00.000Z';
  let generatedRequest;
  const core = await createCompanionCore({
    databasePath: ':memory:', gateway: fx.gateway, now: () => current,
    topicProvider: { async search(query) {
      assert.doesNotMatch(query, /owner|原始聊天/);
      return [{ title: '喜欢量子计算：本周的新进展', url: 'https://example.test/quantum', snippet: '量子计算近期研究', publishedAt: '2026-08-23' }];
    } },
    generator: { async generate(request) { generatedRequest = request; return { bubbles: [{ text: '看到一个量子计算的新进展，想到你了。' }] }; } },
  });
  const memory = core.remember({
    owner_id: 'owner', kind: 'interest', summary: '喜欢量子计算', confidence: 0.9,
    sensitivity: 'normal', evidence_event_id: 'manual:1', expires_at: '2027-08-24T00:00:00.000Z',
  });
  await core.ensureCandidates('owner');
  const topic = core.listCandidates('owner').find((item) => item.window_kind === 'topic');
  current = new Date(Date.parse(topic.scheduled_at) + 1_000).toISOString();
  const result = await core.tick();
  assert.equal(result.generated, 1);
  assert.equal(generatedRequest.sources[0].url, 'https://example.test/quantum');
  assert.match(generatedRequest.prompt, /https:\/\/example\.test\/quantum/);
  assert.match(generatedRequest.prompt, /warm\|playful\|opinionated\|playful_angry\|quiet/);
  assert.match(generatedRequest.prompt, /不要习惯性选择 warm/);
  assert.equal(fx.sent.length, 1);
  assert.equal(core.listTopicSources('owner').length, 1);
  assert.deepEqual(JSON.parse(core.listTopicSources('owner')[0].memory_refs_json), [memory.memoryId]);
  const forgotten = await core.forgetMemory('owner', memory.memoryId);
  assert.equal(forgotten.deletedTopicSources, 1);
  assert.equal(core.listTopicSources('owner').length, 0);
  await core.close();
});

test('text and sticker are delivered while the durable plan stores only stickerId', async (t) => {
  const fx = gatewayFixture();
  const { catalog } = await stickerFixture(t);
  const now = '2026-08-24T04:00:00.000Z';
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fx.gateway, now: () => now, stickerCatalog: catalog });
  const planned = await core.planProactive({
    routeId: fx.route.routeId, reason: 'morning', scheduledAt: now,
    expiresAt: '2026-08-24T05:00:00.000Z',
    generated: { bubbles: [{ text: '早呀' }], stickerIntent: { emotion: 'happy', intensity: 1, context: 'morning' } },
  });
  assert.equal(planned.status, 'planned');
  const stored = core.inspectPlan(planned.planId);
  assert.deepEqual(stored.messages.map((item) => item.content), [
    { kind: 'text', text: '早呀', delayMs: 0 },
    { kind: 'sticker', stickerId: 'happy' },
  ]);
  assert.equal(JSON.stringify(stored).includes('assets'), false);
  const delivered = await core.runOnce();
  assert.equal(delivered.status, 'sent');
  assert.deepEqual(fx.sent.map((item) => item.message.kind), ['text', 'sticker']);
  assert.ok(fx.sent[1].message.file.bytes.byteLength > 0);
  await core.close();
});

test('missing sticker material safely degrades to sent text', async (t) => {
  const fx = gatewayFixture();
  const { catalog, imagePath } = await stickerFixture(t, { cooldownMs: 0 });
  const now = '2026-08-24T04:00:00.000Z';
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fx.gateway, now: () => now, stickerCatalog: catalog });
  const planned = await core.planProactive({
    routeId: fx.route.routeId, reason: 'morning', scheduledAt: now,
    expiresAt: '2026-08-24T05:00:00.000Z',
    generated: { bubbles: [{ text: '今天也要照顾好自己' }], stickerIntent: { emotion: 'happy', intensity: 1, context: 'morning' } },
  });
  await unlink(imagePath);
  const delivered = await core.runOnce();
  assert.equal(delivered.status, 'sent');
  assert.deepEqual(fx.sent.map((item) => item.message.kind), ['text']);
  assert.deepEqual(delivered.messages.map((item) => item.status), ['sent', 'cancelled']);
  assert.equal(delivered.messages[1].delivery_json.includes('sticker-materialization-failed'), true);
  await core.close();
});

test('clingy mode schedules at most one follow-up after an unanswered sent plan', async () => {
  const fx = gatewayFixture({ capabilities: { text: true } });
  let current = '2026-08-24T04:00:00.000Z';
  const core = await createCompanionCore({
    databasePath: ':memory:', gateway: fx.gateway, now: () => current,
    generator: { async generate(request) {
      assert.equal(request.windowKind, 'follow_up');
      return { bubbles: [{ text: '忙完记得回来冒个泡呀' }] };
    } },
  });
  core.updateProfile('owner', { interaction_mode: 'clingy' });
  await core.queuePlan({
    routeId: fx.route.routeId, reason: 'morning', scheduledAt: current,
    expiresAt: '2026-08-24T05:30:00.000Z', messages: [{ kind: 'text', text: '今天过得怎么样？' }],
  });
  assert.equal((await core.runOnce()).status, 'sent');
  const candidate = await core.ensureFollowUp('owner');
  assert.equal(candidate.window_kind, 'follow_up');
  assert.equal(Date.parse(candidate.scheduled_at) - Date.parse(current), 45 * 60_000);
  assert.equal((await core.ensureFollowUp('owner')).candidate_id, candidate.candidate_id);
  current = new Date(Date.parse(candidate.scheduled_at) + 1_000).toISOString();
  for (let attempts = 0; attempts < 3 && fx.sent.length < 2; attempts += 1) await core.tick();
  assert.equal(fx.sent.length, 2);
  assert.equal(fx.sent[1].message.text, '忙完记得回来冒个泡呀');
  assert.equal(core.listCandidates('owner').filter((item) => item.window_kind === 'follow_up').length, 1);
  await core.close();
});
