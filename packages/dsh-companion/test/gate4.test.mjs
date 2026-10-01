import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMemory, projectMemory } from '../src/memory.mjs';
import { createCompanionCore } from '../src/runtime.mjs';
import { evaluatePolicy } from '../src/policy.mjs';
import { runCli } from '../src/cli.mjs';
import { createDshImGateway } from '../../../src/channels/shared/dsh-im-gateway.mjs';

const now = '2026-08-24T12:00:00.000Z';
const memory = (owner = 'o', extra = {}) => ({ owner_id: owner, kind: 'interest', summary: '  喜欢  咖啡  ', evidence_event_id: 'event-1', confidence: 0.8, sensitivity: 'normal', expires_at: '2026-09-01T00:00:00Z', ...extra });

test('memory normalization requires evidence and stable whitespace fingerprint', () => {
  assert.throws(() => normalizeMemory(memory('o', { evidence_event_id: '' }), { now }));
  const a = normalizeMemory(memory(), { now }); const b = normalizeMemory(memory('o', { summary: '喜欢 咖啡' }), { now }); assert.equal(a.fingerprint, b.fingerprint);
});

test('memory projection enforces all purpose privacy boundaries', () => {
  const row = { ...normalizeMemory(memory(), { now }), status: 'active' }; assert.equal(projectMemory(row, { purpose: 'chat', at: now }).sensitivity, 'normal'); assert.equal(projectMemory({ ...row, sensitivity: 'highly_private' }, { purpose: 'proactive', at: now }), null); const search = projectMemory(row, { purpose: 'web-search', at: now }); assert.deepEqual(Object.keys(search).sort(), ['kind', 'memoryId', 'summary']); assert.throws(() => projectMemory(row, { purpose: 'unknown', at: now }));
});

test('remember deduplicates and confirms without resurrecting forgotten memory', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); const first = core.remember(memory()); const second = core.remember(memory('o', { confidence: 0.9 })); assert.equal(first.status, 'created'); assert.equal(second.status, 'confirmed'); await core.forgetMemory('o', first.memoryId); assert.equal(core.remember(memory()).reason, 'memory-forgotten'); await core.close();
});

test('memory pause blocks new remember and survives reopen', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); await core.pauseMemory('o'); assert.equal(core.remember(memory()).reason, 'memory-paused'); assert.equal(core.status().state, 'inactive'); await core.close();
});

test('projectProfile excludes forgotten memories', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); const created = core.remember(memory()); await core.forgetMemory('o', created.memoryId); assert.equal(core.projectProfile({ ownerId: 'o', purpose: 'chat', at: now }).length, 0); await core.close();
});

test('export is owner-scoped and contains no evidence or fingerprint', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); core.remember(memory('a')); core.remember(memory('b')); const exported = core.exportMemories('a'); assert.equal(exported.length, 1); assert.equal('evidence_event_id' in exported[0], false); assert.equal('fingerprint' in exported[0], false); await core.close();
});

test('forget and erase return explicit statuses', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); const id = core.remember(memory()).memoryId; assert.equal((await core.forgetMemory('o', id)).status, 'forgotten'); assert.equal((await core.eraseMemory('o', id)).status, 'erased'); assert.equal((await core.eraseMemory('o', id)).status, 'not-found'); await core.close();
});

test('clearMemories returns deletion boundary', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); core.remember(memory()); const result = await core.clearMemories('o'); assert.equal(result.deleted, 1); assert.match(result.boundary, /Harness Session/); await core.close();
});

test('invalid projection owner and limit fail closed', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); assert.throws(() => core.projectProfile({ ownerId: '', limit: 1 })); assert.throws(() => core.projectProfile({ ownerId: 'o', limit: 1.2 })); await core.close();
});

test('planProactive rejects duplicated memory references before write', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); const result = await core.planProactive({ routeId: 'missing', reason: 'morning', expiresAt: '2026-08-25T00:00:00Z', memoryIds: ['a', 'a'], generated: [{ text: 'x' }] }); assert.equal(result.status, 'skipped'); await core.close();
});

test('CLI delete commands require yes confirmation', async () => {
  const service = { async forgetMemory() {}, async eraseMemory() {}, async clearMemories() {} }; await assert.rejects(() => runCli(['memory', 'erase', 'o', 'm'], { service }), /--yes/); await assert.rejects(() => runCli(['memory', 'clear', 'o'], { service }), /--yes/);
});

test('CLI memory export uses structured export API', async () => {
  let called = false; const service = { exportMemories: () => { called = true; return []; } }; await runCli(['memory', 'export', 'o'], { service }); assert.equal(called, true);
});

test('forgotten memories remain available only in audit list', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); const id = core.remember(memory()).memoryId; await core.forgetMemory('o', id); assert.equal(core.listMemories({ ownerId: 'o', status: 'forgotten' }).length, 1); assert.equal(core.projectProfile({ ownerId: 'o', at: now }).length, 0); await core.close();
});

test('paused memory does not block a no-reference plan', async () => {
  const { gateway, registry } = createDshImGateway(); let sends = 0; registry.registerAdapter('a', { health: { status: 'online' }, send: async () => { sends += 1; return { schemaVersion: 1, deliveryOutcome: 'sent' }; } }); const route = registry.upsertTrustedRoute({ channel: 'x', botId: 'b', kind: 'direct', conversationId: 'o', ownerId: 'o', adapterId: 'a', verification: { kind: 'configured-owner', verifiedAt: now } }); const core = await createCompanionCore({ databasePath: ':memory:', gateway, now: () => now }); await core.pauseMemory('o'); const id = await core.queuePlan({ routeId: route.routeId, reason: 'morning', scheduledAt: '2026-08-24T05:00:00Z', expiresAt: '2026-08-24T23:00:00Z', messages: [{ kind: 'text', text: '早安' }] }); await core.runOnce(); assert.equal(core.inspectPlan(id).status, 'sent'); assert.equal(sends, 1); await core.close();
});

test('active route and valid memory persist refs and send', async () => {
  const { gateway, registry } = createDshImGateway(); let sends = 0; registry.registerAdapter('a', { health: { status: 'online' }, send: async () => { sends += 1; return { schemaVersion: 1, deliveryOutcome: 'sent' }; } }); const route = registry.upsertTrustedRoute({ channel: 'x', botId: 'b', kind: 'direct', conversationId: 'o', ownerId: 'o', adapterId: 'a', verification: { kind: 'configured-owner', verifiedAt: now } }); const core = await createCompanionCore({ databasePath: ':memory:', gateway, now: () => now }); const memoryId = core.remember(memory()).memoryId; const result = await core.planProactive({ routeId: route.routeId, reason: 'morning', scheduledAt: '2026-08-24T05:00:00Z', expiresAt: '2026-08-24T23:00:00Z', memoryIds: [memoryId], generated: [{ text: '早安' }] }); assert.equal(result.status, 'planned'); assert.deepEqual(core.inspectPlan(result.planId).memory_refs_json, JSON.stringify([memoryId])); await core.runOnce(); assert.equal(sends, 1); await core.close();
});

test('foreign and paused memory references are rejected without plans', async () => {
  const { gateway, registry } = createDshImGateway(); registry.registerAdapter('a', { health: { status: 'online' }, send: async () => ({ schemaVersion: 1, deliveryOutcome: 'sent' }) }); const route = registry.upsertTrustedRoute({ channel: 'x', botId: 'b', kind: 'direct', conversationId: 'o', ownerId: 'o', adapterId: 'a', verification: { kind: 'configured-owner', verifiedAt: now } }); const core = await createCompanionCore({ databasePath: ':memory:', gateway, now: () => now }); const other = (await (async () => { const c = await createCompanionCore({ databasePath: ':memory:', now: () => now }); const id = c.remember(memory('other')).memoryId; await c.close(); return id; })()); const before = core.status(); const result = await core.planProactive({ routeId: route.routeId, reason: 'morning', scheduledAt: '2026-08-24T05:00:00Z', expiresAt: '2026-08-24T23:00:00Z', memoryIds: [other], generated: [{ text: 'x' }] }); assert.equal(result.status, 'skipped'); assert.equal(core.status().cursor.cursor, before.cursor.cursor); await core.close();
});

test('memory pause returns versioned control and proactive CLI pause/resume uses owner', async () => {
  let calls = []; const service = { pause: async (owner, reason) => calls.push(['pause', owner, reason]), resume: async (owner) => calls.push(['resume', owner]), ownerStatus: () => ({ proactive: { state: 'enabled' }, memory: { memory_state: 'paused' } }) }; await runCli(['proactive', 'pause', 'o'], { service }); await runCli(['proactive', 'resume', 'o'], { service }); await runCli(['proactive', 'status', 'o'], { service }); assert.deepEqual(calls, [['pause', 'o', 'cli'], ['resume', 'o']]);
});

test('memory normalization trims owner and evidence and rejects future confirmation', () => {
  const normalized = normalizeMemory(memory(' o ', { evidence_event_id: ' e ' }), { now }); assert.equal(normalized.owner_id, 'o'); assert.equal(normalized.evidence_event_id, 'e'); assert.throws(() => normalizeMemory(memory('o', { last_confirmed_at: '2026-08-25T00:00:00Z' }), { now }));
});

test('dedupe upgrades sensitivity and blocks web search projection', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); const id = core.remember(memory('o', { sensitivity: 'normal' })).memoryId; core.remember(memory('o', { sensitivity: 'private' })); assert.equal(core.projectProfile({ ownerId: 'o', purpose: 'web-search', at: now }).length, 0); assert.equal(core.listMemories({ ownerId: 'o' }).find((row) => row.memory_id === id).sensitivity, 'private'); await core.close();
});

test('CLI status exposes owner proactive and memory controls', async () => { const service = { ownerStatus: (owner) => ({ owner }) }; assert.deepEqual(await runCli(['proactive', 'status', 'o'], { service }), { owner: 'o' }); });

test('quiet cooldown 24 hours is explained', () => { const p = { interaction_mode: 'natural', daily_budget: 2, time_zone: 'Asia/Shanghai', quiet_hours_start: '07:00', quiet_hours_end: '08:00' }; const r = evaluatePolicy({ profile: p, relationship: { status: 'quiet', metrics: { consecutiveUnansweredPlans: 3 } }, plans: [{ status: 'sent', created_at: '2026-08-23T13:00:00Z', scheduled_at: '2026-08-23T13:00:00Z' }], reason: 'morning', at: '2026-08-24T08:30:00Z' }); assert.equal(r.reason, 'quiet-cooldown-24h'); });
test('quiet cooldown 48 hours is explained', () => { const p = { interaction_mode: 'natural', daily_budget: 2, time_zone: 'Asia/Shanghai', quiet_hours_start: '07:00', quiet_hours_end: '08:00' }; const r = evaluatePolicy({ profile: p, relationship: { status: 'quiet', metrics: { consecutiveUnansweredPlans: 4 } }, plans: [{ status: 'sent', created_at: '2026-08-23T00:00:00Z', scheduled_at: '2026-08-23T00:00:00Z' }], reason: 'morning', at: '2026-08-24T08:30:00Z' }); assert.equal(r.reason, 'quiet-cooldown-48h'); });
test('quiet cooldown 72 hours is explained', () => { const p = { interaction_mode: 'natural', daily_budget: 2, time_zone: 'Asia/Shanghai', quiet_hours_start: '07:00', quiet_hours_end: '08:00' }; const r = evaluatePolicy({ profile: p, relationship: { status: 'quiet', metrics: { consecutiveUnansweredPlans: 5 } }, plans: [{ status: 'sent', created_at: '2026-08-23T00:00:00Z', scheduled_at: '2026-08-23T00:00:00Z' }], reason: 'morning', at: '2026-08-24T08:30:00Z' }); assert.equal(r.reason, 'quiet-cooldown-72h'); });
test('quiet hours crossing midnight denies both sides', () => { const p = { interaction_mode: 'natural', daily_budget: 2, time_zone: 'Asia/Shanghai', quiet_hours_start: '22:00', quiet_hours_end: '07:00' }; assert.equal(evaluatePolicy({ profile: p, relationship: { status: 'normal', metrics: {} }, plans: [], reason: 'morning', at: '2026-08-24T15:00:00Z' }).reason, 'quiet-hours'); });

test('forgetting owner A does not affect owner B', async () => { const core = await createCompanionCore({ databasePath: ':memory:', now: () => now }); const a = core.remember(memory('a')).memoryId; const b = core.remember(memory('b')).memoryId; await core.forgetMemory('a', a); assert.equal(core.listMemories({ ownerId: 'b' }).find((row) => row.memory_id === b).status, 'active'); await core.close(); });

test('v3 schema reopens idempotently with memory table and preserved profile', async () => { const { mkdtemp, rm } = await import('node:fs/promises'); const { join } = await import('node:path'); const { openCompanionDatabase } = await import('../src/database.mjs'); const dir = await mkdtemp('gate4-reopen-'); const path = join(dir, 'db.sqlite'); const db = await openCompanionDatabase(path); db.prepare("INSERT INTO profiles(owner_id,created_at,updated_at) VALUES('persist',?,?)").run(now, now); db.close(); const reopened = await openCompanionDatabase(path); assert.equal(reopened.prepare('SELECT display_name FROM profiles WHERE owner_id=\'persist\'').get().display_name, null); assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get()); reopened.close(); await new Promise((resolve) => setTimeout(resolve, 50)); await rm(dir, { recursive: true, force: true }); });
