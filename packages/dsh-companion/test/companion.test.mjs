import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDshImGateway } from '../../../src/channels/shared/dsh-im-gateway.mjs';
import { createCompanionCore } from '../src/runtime.mjs';
import { apply as applyCompanionPlugin, bundledCompanionPresetPath, createCompanionHarnessSessionPool, createCompanionPlugin, syncCompanionPreset } from '../src/index.mjs';
import { splitWeixinText } from '../../../src/channels/weixin/weixin-api.mjs';
import { openCompanionDatabase } from '../src/database.mjs';
import { CompanionStore } from '../src/store.mjs';

const routeInput = { channel: 'weixin', botId: 'bot', kind: 'direct', conversationId: 'owner', ownerId: 'owner', adapterId: 'a', verification: { kind: 'configured-owner', verifiedAt: '2026-01-01T00:00:00.000Z' } };
function gatewayFixture({ capacity, send } = {}) {
  const { gateway, registry } = createDshImGateway({ capacity });
  let sends = 0;
  registry.registerAdapter('a', { capabilities: { text: true }, health: { status: 'online' }, send: async (...args) => { sends += 1; return send ? send(...args) : ({ deliveryOutcome: 'sent', schemaVersion: 1, providerMessageIds: ['p'] }); } });
  const route = registry.upsertTrustedRoute(routeInput);
  return { gateway, registry, route, get sends() { return sends; } };
}
const future = '2099-01-01T00:00:00.000Z';

test('migration creates profile/control/cursor defaults and queue persists stable idempotency keys', async () => {
  const { gateway, route } = gatewayFixture();
  const core = await createCompanionCore({ databasePath: ':memory:', gateway });
  assert.equal(core.status().cursor.cursor, '0'); assert.equal(core.status().cursor.state, 'active');
  const planId = await core.queuePlan({ routeId: route.routeId, reason: 'test', expiresAt: future, messages: [{ kind: 'text', text: 'hello' }, { kind: 'text', text: 'world' }] });
  const queued = core.inspectPlan(planId);
  assert.equal(queued.status, 'planned');
  assert.equal(queued.messages[0].idempotency_key, `${planId}:0`);
  await core.runOnce();
  assert.equal(core.inspectPlan(planId).status, 'sent');
  assert.equal(core.status().cursor.state, 'active');
  await core.close();
});

test('ordinary chat replies send a sticker no later than the third eligible reply', async () => {
  const sent = [];
  const fixture = gatewayFixture({ send: async (_route, message) => {
    sent.push(message);
    return { deliveryOutcome: 'sent', schemaVersion: 1, providerMessageIds: ['p'] };
  } });
  const gateway = { ...fixture.gateway, getCapabilities: async () => ({ text: true, image: true }) };
  const stickerCatalog = {
    select: () => ({ id: 'money-one' }),
    materialize: async () => ({ bytes: new Uint8Array([1]), fileName: 'money-one.png', mediaType: 'image/png' }),
  };
  const core = await createCompanionCore({
    databasePath: ':memory:', gateway, stickerCatalog,
    replySticker: { enabled: true, probability: 0, forceAfterEligibleMisses: 2, delayMs: 0 },
    random: () => 0.99,
  });
  for (let index = 1; index <= 3; index += 1) {
    fixture.registry.recordInbound(fixture.route.routeId, { messageId: `chat-${index}`, normalizedText: '想找点赚钱的路子' });
    fixture.registry.recordConversationReply(fixture.route.routeId, { messageId: `chat-${index}`, inputText: '想找点赚钱的路子', outputText: '那咱先看看你会啥' });
    await core.drain();
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'sticker');
  assert.equal(sent[0].stickerId, 'money-one');
  await core.close();
});

test('queuePlan rejects malformed reasons, dates, prototypes, and non-text messages', async () => {
  const { gateway, route } = gatewayFixture(); const core = await createCompanionCore({ databasePath: ':memory:', gateway });
  const base = { routeId: route.routeId, reason: 'valid', expiresAt: future };
  await assert.rejects(() => core.queuePlan({ ...base, reason: '', messages: [{ kind: 'text', text: 'x' }] }));
  await assert.rejects(() => core.queuePlan({ ...base, expiresAt: 'bad-date', messages: [{ kind: 'text', text: 'x' }] }));
  await assert.rejects(() => core.queuePlan({ ...base, messages: [{ kind: 'image', text: 'x' }] }));
  await assert.rejects(() => core.queuePlan({ ...base, messages: [{ kind: 'text', text: 'x', extra: true }] }));
  await core.close();
});

test('advanceCursor reports exact monotonic changes without rewriting stale state', async () => {
  const db = await openCompanionDatabase(':memory:'); const store = new CompanionStore(db, () => '2026-01-01T00:00:00.000Z');
  assert.equal(store.advanceCursor('0', 'active'), false); assert.equal(store.advanceCursor('0', 'needs_resync'), true); assert.equal(store.advanceCursor('1', 'active'), true); assert.equal(store.advanceCursor('0', 'paused'), false); assert.deepEqual({ cursor: store.cursor().cursor, state: store.cursor().state }, { cursor: '1', state: 'active' }); db.close();
});

test('two workers claim one plan and send once', async () => {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-workers-'));
  try {
    const fixture = gatewayFixture(); const { gateway, route } = fixture;
    const first = await createCompanionCore({ databasePath: join(dir, 'db.sqlite'), gateway, workerId: 'one' });
    const second = await createCompanionCore({ databasePath: join(dir, 'db.sqlite'), gateway, workerId: 'two' });
    await first.queuePlan({ routeId: route.routeId, reason: 'once', expiresAt: future, messages: [{ kind: 'text', text: 'one' }] });
    await Promise.all([first.runOnce(), second.runOnce()]);
    assert.equal(fixture.sends, 1);
    await first.close(); await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unknown delivery stays unknown across restart and is never retried', async () => {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-unknown-'));
  try {
    const fixture = gatewayFixture({ send: async () => ({ schemaVersion: 1, deliveryOutcome: 'unknown', reason: 'network-error', providerMessageIds: [] }) });
    const first = await createCompanionCore({ databasePath: join(dir, 'db.sqlite'), gateway: fixture.gateway });
    const planId = await first.queuePlan({ routeId: fixture.route.routeId, reason: 'unknown', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] });
    await first.runOnce(); assert.equal(first.inspectPlan(planId).status, 'delivery_unknown'); await first.close();
    const second = await createCompanionCore({ databasePath: join(dir, 'db.sqlite'), gateway: fixture.gateway });
    assert.equal(second.inspectPlan(planId).status, 'delivery_unknown'); await second.runOnce(); assert.equal(fixture.sends, 1); await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('first explicit failure cancels the second bubble and leaves plan failed_final', async () => {
  const fixture = gatewayFixture({ send: async () => ({ schemaVersion: 1, deliveryOutcome: 'failed', reason: 'rejected', providerMessageIds: [] }) });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fixture.gateway });
  const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'failure', expiresAt: future, messages: [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }] });
  await core.runOnce(); const plan = core.inspectPlan(planId); assert.equal(plan.status, 'failed_final'); assert.equal(plan.messages[0].status, 'failed_final'); assert.equal(plan.messages[1].status, 'cancelled'); assert.equal(fixture.sends, 1); await core.close();
});

test('health exception before first bubble fails closed without a claimed plan', async () => {
  const fixture = gatewayFixture(); const gateway = { ...fixture.gateway, getHealth: () => { throw new Error('health unavailable'); } }; const core = await createCompanionCore({ databasePath: ':memory:', gateway });
  const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'health', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] }); await core.runOnce(); const plan = core.inspectPlan(planId); assert.equal(plan.status, 'cancelled'); assert.equal(plan.messages[0].status, 'cancelled'); assert.equal(fixture.sends, 0); await core.close();
});

test('health exception between bubbles cancels the remainder without leaving sending', async () => {
  const fixture = gatewayFixture(); let healthCalls = 0; const gateway = { ...fixture.gateway, getHealth: () => { healthCalls += 1; if (healthCalls === 3) throw new Error('health unavailable'); return { status: 'online' }; } }; const core = await createCompanionCore({ databasePath: ':memory:', gateway });
  const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'health-two', expiresAt: future, messages: [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }] }); await core.runOnce(); const plan = core.inspectPlan(planId); assert.equal(plan.status, 'sent'); assert.equal(plan.messages[0].status, 'sent'); assert.equal(plan.messages[1].status, 'cancelled'); assert.equal(fixture.sends, 1); await core.close();
});

test('Abort after markSending persists unknown and never retries', async () => {
  const fixture = gatewayFixture({ send: async () => { throw new DOMException('aborted', 'AbortError'); } });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fixture.gateway });
  const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'abort', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] });
  await assert.rejects(() => core.runOnce(), (error) => error.name === 'AbortError'); assert.equal(core.inspectPlan(planId).status, 'delivery_unknown'); await core.runOnce(); assert.equal(fixture.sends, 1); await core.close();
});

test('pause command replay cancels plans and does not persist inbound text', async () => {
  const fixture = gatewayFixture(); const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-privacy-')); const dbPath = join(dir, 'db.sqlite'); const logs = [];
  const core = await createCompanionCore({ databasePath: dbPath, gateway: fixture.gateway, logger: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) } });
  const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'pause-test', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] });
  await core.detachGateway();
  fixture.registry.recordInbound(fixture.route.routeId, { messageId: 'pause', normalizedText: ' /companion pause ' });
  await core.attachGateway(fixture.gateway);
  assert.equal(core.status().state, 'active');
  assert.equal(core.inspectPlan(planId).status, 'cancelled');
  assert.equal(core.status().state, 'active');
  await core.close(); const db = new DatabaseSync(dbPath); const event = db.prepare('SELECT * FROM interaction_events').get(); assert.equal(JSON.stringify(event).includes('/companion pause'), false); assert.equal(Object.hasOwn(event, 'normalizedText'), false); assert.equal(logs.some((args) => args.some((value) => String(value).includes('/companion pause'))), false); db.close(); await rm(dir, { recursive: true, force: true });
});

test('expired cursor fails closed until explicit resync confirmation', async () => {
  const fixture = gatewayFixture({ capacity: 1 });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fixture.gateway });
  await core.detachGateway();
  fixture.registry.recordInbound(fixture.route.routeId, { messageId: 'one' });
  fixture.registry.recordInbound(fixture.route.routeId, { messageId: 'two' });
  await core.attachGateway(fixture.gateway);
  assert.equal(core.status().state, 'inactive-needs-resync');
  await assert.rejects(() => core.queuePlan({ routeId: fixture.route.routeId, reason: 'blocked', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] }));
  await core.confirmGatewayResync({ ownerId: 'owner', proactiveState: 'paused' });
  assert.equal(core.status().state, 'active');
  await core.close();
});

test('a fresh in-memory gateway rebases a persisted cursor after DSH restart', async () => {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-gateway-restart-'));
  const dbPath = join(dir, 'db.sqlite');
  let core;
  try {
    const beforeRestart = gatewayFixture();
    const first = await createCompanionCore({ databasePath: dbPath, gateway: beforeRestart.gateway });
    beforeRestart.registry.recordInbound(beforeRestart.route.routeId, { messageId: 'old-1', normalizedText: '旧进程消息' });
    await first.drain();
    assert.equal(first.status().cursor.cursor, '1');
    await first.close();

    const sent = [];
    const afterRestart = gatewayFixture({ send: async (_route, message) => {
      sent.push(message);
      return { deliveryOutcome: 'sent', schemaVersion: 1, providerMessageIds: ['p'] };
    } });
    const gateway = { ...afterRestart.gateway, getCapabilities: async () => ({ text: true, image: true }) };
    core = await createCompanionCore({
      databasePath: dbPath,
      gateway,
      stickerCatalog: {
        select: () => ({ id: 'restart-sticker' }),
        materialize: async () => ({ bytes: new Uint8Array([1]), fileName: 'restart.png', mediaType: 'image/png' }),
      },
      replySticker: { enabled: true, probability: 1, delayMs: 0 },
    });
    assert.equal(core.status().state, 'active');
    assert.equal(core.status().cursor.cursor, '0');
    afterRestart.registry.recordInbound(afterRestart.route.routeId, { messageId: 'new-1', normalizedText: '哈哈今天好开心' });
    afterRestart.registry.recordConversationReply(afterRestart.route.routeId, { messageId: 'new-1', inputText: '哈哈今天好开心', outputText: '看出来啦，尾巴都翘起来了' });
    await core.drain();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].stickerId, 'restart-sticker');
    assert.equal(core.status().cursor.cursor, '1');
  } finally {
    await core?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('route revision change cancels a queued plan and no gateway is inactive', async () => {
  const fixture = gatewayFixture();
  const core = await createCompanionCore({ databasePath: ':memory:' });
  assert.equal(core.status().state, 'inactive'); await core.close();
  const active = await createCompanionCore({ databasePath: ':memory:', gateway: fixture.gateway });
  const planId = await active.queuePlan({ routeId: fixture.route.routeId, reason: 'revision', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] });
  fixture.registry.upsertTrustedRoute(routeInput);
  await active.drain(); await active.runOnce();
  assert.equal(active.inspectPlan(planId).status, 'cancelled'); await active.close();
});

test('recover marks an in-flight sending attempt unknown and never retries it', async () => {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-recover-'));
  try {
    const fixture = gatewayFixture(); let sends = 0;
    const dbPath = join(dir, 'db.sqlite');
    const first = await createCompanionCore({ databasePath: dbPath, gateway: fixture.gateway });
    const planId = await first.queuePlan({ routeId: fixture.route.routeId, reason: 'crash', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] });
    await first.close();
    const db = new DatabaseSync(dbPath); const message = db.prepare('SELECT message_id FROM plan_messages WHERE plan_id=?').get(planId);
    db.prepare("UPDATE proactive_plans SET status='sending' WHERE plan_id=?").run(planId); db.prepare("UPDATE plan_messages SET status='sending' WHERE message_id=?").run(message.message_id); db.prepare("INSERT INTO delivery_attempts(attempt_id,message_id,idempotency_key,started_at) VALUES('crash-attempt',?,?,?)").run(message.message_id, `${planId}:0`, new Date().toISOString()); db.close();
    const recovered = await createCompanionCore({ databasePath: dbPath, gateway: fixture.gateway });
    assert.equal(recovered.inspectPlan(planId).status, 'delivery_unknown'); await recovered.runOnce(); assert.equal(sends, 0); await recovered.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recover releases an unattempted claim and expires stale plans', async () => {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-recover-claim-'));
  try {
    const fixture = gatewayFixture(); const dbPath = join(dir, 'db.sqlite');
    const first = await createCompanionCore({ databasePath: dbPath, gateway: fixture.gateway });
    const planId = await first.queuePlan({ routeId: fixture.route.routeId, reason: 'claim', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] });
    const staleId = await first.queuePlan({ routeId: fixture.route.routeId, reason: 'stale', expiresAt: '2000-01-01T00:00:00.000Z', messages: [{ kind: 'text', text: 'stale' }] }); await first.close();
    const db = new DatabaseSync(dbPath); db.prepare("UPDATE proactive_plans SET status='claimed',lease_owner='dead',lease_until=? WHERE plan_id=?").run(future, planId); db.prepare("UPDATE proactive_plans SET status='claimed',lease_owner='dead',lease_until=? WHERE plan_id=?").run(future, staleId); db.close();
    const recovered = await createCompanionCore({ databasePath: dbPath, gateway: fixture.gateway }); assert.equal(recovered.inspectPlan(planId).status, 'planned'); assert.equal(recovered.inspectPlan(staleId).status, 'expired'); await recovered.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('owner inbound between bubbles keeps the sent bubble and cancels the remainder', async () => {
  let fixture; let sent = 0;
  fixture = gatewayFixture({ send: async (route) => { sent += 1; if (sent === 1) fixture.registry.recordInbound(fixture.route.routeId, { messageId: 'between', normalizedText: 'pause' }); return { schemaVersion: 1, deliveryOutcome: 'sent', providerMessageIds: ['p'] }; } });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fixture.gateway });
  const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'bubbles', expiresAt: future, messages: [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }] });
  await core.runOnce(); await core.drain(); const plan = core.inspectPlan(planId); assert.equal(plan.status, 'sent'); assert.equal(plan.messages[0].status, 'sent'); assert.equal(plan.messages[1].status, 'cancelled'); assert.equal(sent, 1); await core.close();
});

test('inbound/live replay cursor never regresses or repeats side effects', async () => {
  const fixture = gatewayFixture(); const originalRead = fixture.gateway.readInboundSince; let injected = false; let savedListener;
  const gateway = { ...fixture.gateway, onInbound: (listener) => { savedListener = listener; return fixture.gateway.onInbound(listener); }, readInboundSince: (...args) => { if (!injected) { injected = true; fixture.registry.recordInbound(fixture.route.routeId, { messageId: 'race', normalizedText: '/companion pause' }); } return originalRead(...args); } };
  const core = await createCompanionCore({ databasePath: ':memory:', gateway }); await core.drain(); assert.equal(core.status().cursor.cursor, '1'); const before = core.status().cursor.cursor; await savedListener({ cursor: '0', routeId: fixture.route.routeId, messageId: 'late', occurredAt: new Date().toISOString(), inboundVersion: 0, routeVersion: 1, controlIntent: 'resume_proactive' }); await core.drain(); assert.equal(core.status().cursor.cursor, before); await core.close();
});

test('close during injected wait leaves no claimed or sending plan and is idempotent', async () => {
  const fixture = gatewayFixture(); let release; const waiting = new Promise((resolve) => { release = resolve; }); const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-close-')); const dbPath = join(dir, 'db.sqlite');
  try { const core = await createCompanionCore({ databasePath: dbPath, gateway: fixture.gateway, wait: () => waiting }); const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'close', expiresAt: future, messages: [{ kind: 'text', text: 'one' }, { kind: 'text', delayMs: 1, text: 'two' }] }); const running = core.runOnce(); await new Promise((resolve) => setImmediate(resolve)); const closing = core.close(); release(); await closing; await running; await core.close(); const db = new DatabaseSync(dbPath); const plan = db.prepare('SELECT status FROM proactive_plans WHERE plan_id=?').get(planId); const messages = db.prepare('SELECT status FROM plan_messages WHERE plan_id=?').all(planId); assert.ok(['sent', 'cancelled'].includes(plan.status)); assert.equal(messages.some((message) => ['claimed', 'sending'].includes(message.status)), false); db.close(); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('explicit paused resync remains fail closed', async () => {
  const fixture = gatewayFixture({ capacity: 1 }); const core = await createCompanionCore({ databasePath: ':memory:', gateway: fixture.gateway }); await core.detachGateway(); fixture.registry.recordInbound(fixture.route.routeId, { messageId: 'a' }); fixture.registry.recordInbound(fixture.route.routeId, { messageId: 'b' }); await core.attachGateway(fixture.gateway); await core.confirmGatewayResync({ ownerId: 'owner', proactiveState: 'paused' }); const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'paused', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] }); await core.runOnce(); assert.equal(core.inspectPlan(planId).status, 'cancelled'); assert.equal(fixture.sends, 0); await core.close();
});

test('route revoke prevents a queued plan from sending', async () => {
  const fixture = gatewayFixture(); const core = await createCompanionCore({ databasePath: ':memory:', gateway: fixture.gateway }); const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'revoke', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] }); fixture.registry.revokeRoute(fixture.route.routeId); await core.drain(); await core.runOnce(); assert.equal(core.inspectPlan(planId).status, 'cancelled'); assert.equal(fixture.sends, 0); await core.close();
});

test('inboundVersion change prevents a queued plan from sending', async () => {
  const fixture = gatewayFixture(); const core = await createCompanionCore({ databasePath: ':memory:', gateway: fixture.gateway }); const planId = await core.queuePlan({ routeId: fixture.route.routeId, reason: 'inbound-version', expiresAt: future, messages: [{ kind: 'text', text: 'x' }] }); fixture.registry.recordInbound(fixture.route.routeId, { messageId: 'new-inbound' }); await core.drain(); await core.runOnce(); assert.equal(core.inspectPlan(planId).status, 'cancelled'); assert.equal(fixture.sends, 0); await core.close();
});

test('plugin lifecycle provides, attaches, detaches, and closes cleanly', async () => {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-plugin-')); const path = join(dir, 'db.sqlite');
  try {
    const fixture = gatewayFixture(); let provided; let injector; let effect;
    const ctx = { provide: (name, value) => { if (name === 'dshCompanion') provided = value; }, inject: (_names, callback) => { injector = callback; }, effect: (callback) => { effect = callback; } };
    const core = await createCompanionPlugin(ctx, { databasePath: path }); assert.equal(provided, core); const detach = await injector(fixture.gateway); assert.equal(core.status().gatewayAttached, true); await detach(); assert.equal(core.status().gatewayAttached, false); const cleanup = effect(); await cleanup(); const reopened = new DatabaseSync(path); reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('plugin reads optional Cordis services only inside their inject scopes', async () => {
  const callbacks = new Map(); let cleanup;
  const context = new Proxy({
    provide() {},
    inject(names, callback) { callbacks.set(names[0], callback); },
    effect(callback) { cleanup = callback; },
  }, {
    get(target, property, receiver) {
      if (['dshCompanionHarness', 'dshImGateway', 'systemPrompt'].includes(property)) {
        throw new Error(`cannot get property "${property}" without inject`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const core = await createCompanionPlugin(context, { databasePath: ':memory:' });
  assert.deepEqual([...callbacks.keys()], ['dshCompanionHarness', 'systemPrompt', 'dshImGateway']);
  assert.equal(core.status().gatewayAttached, false);
  await cleanup()();
});

test('Cordis apply resolves without returning the provided core as an effect', async () => {
  let cleanup;
  const context = {
    provide() {},
    inject() {},
    effect(callback) { cleanup = callback; },
  };
  assert.equal(await applyCompanionPlugin(context, { databasePath: ':memory:' }), undefined);
  await cleanup()();
});

test('companion preset sync installs the human companion persona into the DSH preset root', async () => {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-preset-'));
  const source = join(dir, 'source');
  try {
    await mkdir(source, { recursive: true });
    await mkdir(join(source, 'skills', 'dsh-companion-humor'), { recursive: true });
    await writeFile(join(source, 'agent.cordis.yml'), 'persona-content', 'utf8');
    await writeFile(join(source, 'preset.yml'), 'metadata-content', 'utf8');
    await writeFile(join(source, 'skills', 'dsh-companion-humor', 'SKILL.md'), 'humor-skill-content', 'utf8');
    const installed = await syncCompanionPreset({ dshHome: join(dir, 'home'), sourceDir: source });
    assert.equal(await readFile(join(installed, 'agent.cordis.yml'), 'utf8'), 'persona-content');
    assert.equal(await readFile(join(installed, 'preset.yml'), 'utf8'), 'metadata-content');
    assert.equal(await readFile(join(dir, 'home', 'skills', 'dsh-companion-humor', 'SKILL.md'), 'utf8'), 'humor-skill-content');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundled companion persona can use visible plugin tools with side-effect boundaries', async () => {
  const persona = await readFile(join(bundledCompanionPresetPath(), 'agent.cordis.yml'), 'utf8');
  const humorSkill = await readFile(join(bundledCompanionPresetPath(), 'skills', 'dsh-companion-humor', 'SKILL.md'), 'utf8');
  assert.match(persona, /已经安装并启用的 DSH 插件/);
  assert.match(persona, /有副作用操作，必须先得到用户明确同意/);
  assert.match(persona, /dsh-skill-filesystem/);
  assert.match(persona, /dsh-tool-skill/);
  assert.match(persona, /每轮最多一个幽默动作/);
  assert.match(persona, /认真倾诉、悲伤、危机、健康、自我价值等话题先接住/);
  assert.match(humorSkill, /整次不超过 70 个汉字/);
  assert.match(humorSkill, /禁止用第一人称生活经历铺垫段子/);
});

test('companion Harness providers reuse one internal session per purpose', async () => {
  let creates = 0;
  const pool = createCompanionHarnessSessionPool({
    createSession: async () => `session-${++creates}`,
    sessionExists: async () => true,
    ask: async (_sessionId, prompt) => prompt,
  });
  assert.equal(await pool.createSession({ purpose: 'companion-memory' }), 'session-1');
  assert.equal(await pool.createSession({ purpose: 'companion-memory' }), 'session-1');
  assert.equal(await pool.createSession({ purpose: 'web-search' }), 'session-2');
  assert.equal(await pool.createSession({ windowKind: 'morning' }), 'session-3');
  assert.equal(await pool.createSession({ windowKind: 'evening' }), 'session-3');
  assert.equal(creates, 3);
});

test('Weixin companion replies become separate bubbles and oversize text splits at sentences', () => {
  assert.deepEqual(splitWeixinText('先接住你。\n\n再问一句。', 72), ['先接住你。', '再问一句。']);
  assert.deepEqual(splitWeixinText('先接住你。\n再问一句。', 72), ['先接住你。', '再问一句。']);
  const long = '哈哈，钱和对象这事儿，多少人都被卡在这儿过，不奇怪。没钱确实会让人心里没底，但没钱就找不到对象，多少有点吓唬自己了。想赚钱本身是好事。';
  const chunks = splitWeixinText(long, 72);
  assert.equal(chunks[0].endsWith('。'), true);
  assert.equal(chunks.join(''), long);
});
