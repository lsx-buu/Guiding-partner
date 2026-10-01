import assert from 'node:assert/strict';
import test from 'node:test';

import { createDshImGateway } from '../../../src/channels/shared/dsh-im-gateway.mjs';
import { createCompanionCore } from '../src/runtime.mjs';
import { parseMemoryExtraction } from '../src/memory-extractor.mjs';
import { installCompanionSystemPrompt } from '../src/system-prompt.mjs';

function gatewayFixture() {
  const { gateway, registry } = createDshImGateway();
  registry.registerAdapter('memory', { health: { status: 'online' }, capabilities: { text: true }, send: async () => ({ deliveryOutcome: 'sent' }) });
  const route = registry.upsertTrustedRoute({
    channel: 'memory', botId: 'bot', kind: 'direct', conversationId: 'owner', ownerId: 'owner',
    adapterId: 'memory', verification: { kind: 'configured-owner', verifiedAt: '2026-08-24T00:00:00.000Z' },
  });
  return { gateway, registry, route };
}

test('strict memory extraction rejects low-confidence and unknown fields', () => {
  assert.throws(() => parseMemoryExtraction({ memories: [{ kind: 'interest', summary: '用户喜欢爵士乐', confidence: 0.2, sensitivity: 'normal', ttlDays: 90 }] }));
  assert.throws(() => parseMemoryExtraction({ memories: [{ kind: 'interest', summary: '用户喜欢爵士乐', confidence: 0.8, sensitivity: 'normal', ttlDays: 90, rawText: 'secret' }] }));
  assert.deepEqual(parseMemoryExtraction({ memories: [] }), []);
});

test('live inbound text is distilled into governed memory without manual API calls', async () => {
  const fx = gatewayFixture();
  let extractorCalls = 0;
  const core = await createCompanionCore({
    databasePath: ':memory:', gateway: fx.gateway, now: () => '2026-08-24T04:00:00.000Z',
    memoryExtractor: { async extract({ text, existing }) {
      extractorCalls += 1;
      assert.equal(text, '我最近越来越喜欢爵士乐，尤其是钢琴三重奏');
      assert.deepEqual(existing, []);
      return [{ kind: 'interest', summary: '用户喜欢爵士钢琴三重奏', confidence: 0.9, sensitivity: 'normal', ttlDays: 180 }];
    } },
  });
  fx.registry.recordInbound(fx.route.routeId, {
    messageId: 'inbound-memory-1', occurredAt: '2026-08-24T04:00:00.000Z',
    normalizedText: '我最近越来越喜欢爵士乐，尤其是钢琴三重奏',
  });
  await core.drain();
  assert.equal(extractorCalls, 1);
  const memories = core.listMemories({ ownerId: 'owner', status: 'active' });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].summary, '用户喜欢爵士钢琴三重奏');
  assert.equal(memories[0].evidence_event_id, `gateway-message:${fx.route.routeId}:inbound-memory-1`);
  await core.close();
});

test('paused memory prevents the extractor from seeing later inbound text', async () => {
  const fx = gatewayFixture();
  let extractorCalls = 0;
  const core = await createCompanionCore({
    databasePath: ':memory:', gateway: fx.gateway,
    memoryExtractor: { async extract() { extractorCalls += 1; return []; } },
  });
  await core.pauseMemory('owner');
  fx.registry.recordInbound(fx.route.routeId, { messageId: 'paused-memory', normalizedText: '不要提取这一条' });
  await core.drain();
  assert.equal(extractorCalls, 0);
  await core.close();
});

test('human-voice system prompt installs once and contains privacy and anti-coercion rules', () => {
  const sections = [];
  const systemPrompt = { section: (value) => sections.push(value) };
  assert.equal(installCompanionSystemPrompt({ systemPrompt }), true);
  assert.equal(installCompanionSystemPrompt({ systemPrompt }), false);
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /短句/);
  assert.match(sections[0].text, /禁止.*内疚/);
  assert.match(sections[0].text, /平等关系/);
  assert.match(sections[0].text, /opinionated/);
  assert.match(sections[0].text, /不要默认赞同/);
  assert.match(sections[0].text, /抽象主题/);
  assert.match(sections[0].text, /每轮最多一个幽默动作/);
  assert.match(sections[0].text, /认真倾诉、悲伤、危机、健康和自我价值话题先接住/);
  assert.match(sections[0].text, /dsh-companion-humor skill/);
});
