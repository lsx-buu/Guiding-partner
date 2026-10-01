import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { openCompanionDatabase } from '../src/database.mjs';
import { calculateRelationship } from '../src/relationship.mjs';
import { evaluatePolicy } from '../src/policy.mjs';
import { buildCompanionPrompt, normalizeBubbles, validatePlayfulAngry } from '../src/persona.mjs';
import { createCompanionCore } from '../src/runtime.mjs';
import { createDshImGateway } from '../../../src/channels/shared/dsh-im-gateway.mjs';

const at = '2026-08-24T12:00:00.000Z';
test('v1 database migrates to the current schema while preserving profile and events', async () => {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'companion-v1-')); const path = join(dir, 'v1.sqlite');
  try { const db = new DatabaseSync(path); db.exec("CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1); CREATE TABLE profiles(owner_id TEXT PRIMARY KEY, display_name TEXT, time_zone TEXT, interaction_mode TEXT NOT NULL DEFAULT 'natural', daily_budget INTEGER NOT NULL DEFAULT 3, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE interaction_events(event_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, route_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, inbound_version INTEGER, control_intent TEXT); INSERT INTO profiles VALUES('o','old','Asia/Shanghai','natural',3,'x','x'); INSERT INTO interaction_events VALUES('e','o','r','user_initiated','2026-08-24T00:00:00Z',1,NULL);"); db.close(); const upgraded = await openCompanionDatabase(path); assert.equal(upgraded.prepare('SELECT version FROM schema_version').get().version, 6); assert.equal(upgraded.prepare('SELECT display_name FROM profiles WHERE owner_id=\'o\'').get().display_name, 'old'); assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM interaction_events').get().n, 1); assert.ok(upgraded.prepare('SELECT quiet_hours_start FROM profiles').get().quiet_hours_start); assert.ok(upgraded.prepare("SELECT name FROM pragma_table_info('owner_controls') WHERE name='memory_state'").get()); upgraded.close(); } finally { for (let attempt = 0; attempt < 8; attempt += 1) { try { await rm(dir, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } }
});

test('relationship formula returns exact neutral, warm, feedback, and unanswered metrics', () => {
  const neutral = calculateRelationship({ ownerId: 'o', at, events: [], plans: [] }); assert.equal(neutral.temperature, 0.5); assert.equal(neutral.status, 'normal');
  const plans = [{ plan_id: 'p', owner_id: 'o', sent_at: '2026-08-24T06:00:00.000Z', sent: 1 }]; const events = [{ owner_id: 'o', kind: 'reply', plan_id: 'p', occurred_at: '2026-08-24T07:00:00.000Z', feedback: null }]; const warm = calculateRelationship({ ownerId: 'o', at, plans, events }); assert.equal(warm.metrics.replyRate, 1); assert.equal(warm.metrics.replySpeed, 5 / 6); assert.ok(warm.temperature > neutral.temperature);
  const negative = calculateRelationship({ ownerId: 'o', at, plans, events: [...events, { owner_id: 'o', kind: 'feedback', feedback: 'explicit_negative', occurred_at: at }] }); assert.equal(negative.metrics.explicitFeedbackAdjustment, -0.3);
  const unanswered = calculateRelationship({ ownerId: 'o', at, plans: [{ plan_id: 'a', owner_id: 'o', sent_at: '2026-08-23T00:00:00Z', sent: 1 }, { plan_id: 'b', owner_id: 'o', sent_at: '2026-08-22T00:00:00Z', sent: 1 }, { plan_id: 'c', owner_id: 'o', sent_at: '2026-08-21T00:00:00Z', sent: 1 }], events: [] }); assert.equal(unanswered.metrics.consecutiveUnansweredPlans, 3); assert.equal(unanswered.status, 'quiet');
});

test('policy enforces modes, budget, timezone, quiet hours, and pauses with reasons', () => {
  const profile = { interaction_mode: 'gentle', time_zone: 'Asia/Shanghai', quiet_hours_start: '00:00', quiet_hours_end: '07:00' }; const relationship = { status: 'normal', metrics: { consecutiveUnansweredPlans: 0 } };
  assert.equal(evaluatePolicy({ profile, relationship, plans: [], at: '2026-08-23T22:00:00Z', reason: 'morning', proactiveState: 'enabled' }).reason, 'quiet-hours');
  assert.equal(evaluatePolicy({ profile, relationship, plans: [], at: at, reason: 'morning', proactiveState: 'paused' }).reason, 'paused');
  assert.equal(evaluatePolicy({ profile: { ...profile, time_zone: 'bad/zone' }, relationship, plans: [], at, reason: 'morning' }).reason, 'invalid-time-zone');
  assert.equal(evaluatePolicy({ profile: { ...profile, interaction_mode: 'clingy' }, relationship, plans: [], at, reason: 'morning', requestedBubbles: 3 }).allowed, false);
  assert.equal(evaluatePolicy({ profile: { ...profile, interaction_mode: 'clingy' }, relationship: { status: 'warm', metrics: { consecutiveUnansweredPlans: 0 } }, plans: [], at, reason: 'morning', requestedBubbles: 2 }).allowed, true);
});

test('persona rejects coercive language and gates playful angry on warm replied context', () => {
  assert.throws(() => normalizeBubbles([{ text: '你不回复我就是因为你不在乎我' }])); assert.throws(() => normalizeBubbles([{ text: 'x', delayMs: -1 }])); assert.equal(validatePlayfulAngry({ relationship: { status: 'warm' }, lastPlanReplied: true }), true); assert.equal(validatePlayfulAngry({ relationship: { status: 'normal' }, lastPlanReplied: true }), false); assert.throws(() => normalizeBubbles([{ text: '哼' }, { text: '我还在生气' }], { context: 'playful_angry' })); assert.doesNotThrow(() => normalizeBubbles([{ text: '哼' }, { text: '好啦，等你有空再告诉我' }], { context: 'playful_angry' }));
});

test('planProactive policy denial does not write a plan', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:' }); assert.equal((await core.planProactive({ routeId: 'missing', reason: 'morning', expiresAt: at, generated: [{ text: 'hi' }] })).status, 'skipped'); await core.close();
});

test('planProactive accepts structured persona output, persists text kind, and sends on an active route', async () => {
  const { gateway, registry } = createDshImGateway(); let sends = 0;
  registry.registerAdapter('a', { health: { status: 'online' }, send: async () => { sends += 1; return { schemaVersion: 1, deliveryOutcome: 'sent', providerMessageIds: ['p'] }; } });
  const route = registry.upsertTrustedRoute({ channel: 'weixin', botId: 'b', kind: 'direct', conversationId: 'o', ownerId: 'o', adapterId: 'a', verification: { kind: 'configured-owner', verifiedAt: '2026-01-01T00:00:00Z' } });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway }); const result = await core.planProactive({ routeId: route.routeId, reason: 'morning', scheduledAt: '2026-08-24T05:00:00.000Z', expiresAt: '2026-08-24T23:00:00Z', generated: { tone: 'warm', bubbles: [{ text: '早安呀' }] } }); assert.equal(result.status, 'planned'); const plan = core.inspectPlan(result.planId); assert.equal(plan.messages[0].content.kind, 'text'); await core.runOnce(); assert.equal(core.inspectPlan(result.planId).status, 'sent'); assert.equal(sends, 1); await core.close();
});

test('relationship newest unanswered plan is not marked replied', () => {
  const plans = [{ owner_id: 'o', plan_id: 'old', sent_at: '2026-08-23T00:00:00Z', sent: 1 }, { owner_id: 'o', plan_id: 'new', sent_at: '2026-08-24T08:00:00Z', sent: 1 }];
  const events = [{ owner_id: 'o', kind: 'reply', plan_id: 'old', occurred_at: '2026-08-23T01:00:00Z' }];
  assert.equal(calculateRelationship({ ownerId: 'o', at, plans, events }).lastPlanReplied, false);
});

test('relationship ignores an immature newest plan when calculating unanswered streak', () => {
  const plans = [0, 1, 2].map((days) => ({ owner_id: 'o', plan_id: `old-${days}`, sent_at: new Date(Date.parse(at) - (days + 1) * 86_400_000).toISOString(), sent: 1 }));
  plans.unshift({ owner_id: 'o', plan_id: 'new', sent_at: new Date(Date.parse(at) - 60 * 60_000).toISOString(), sent: 1 });
  assert.equal(calculateRelationship({ ownerId: 'o', at, plans, events: [] }).metrics.consecutiveUnansweredPlans, 3);
});

test('relationship feedback expires outside the thirty day window', () => {
  const result = calculateRelationship({ ownerId: 'o', at, plans: [], events: [{ owner_id: 'o', kind: 'feedback', feedback: 'explicit_positive', occurred_at: '2026-07-01T00:00:00Z' }] });
  assert.equal(result.metrics.explicitFeedbackAdjustment, 0);
});

test('gentle mode keeps one bubble in warm state', () => {
  const profile = { interaction_mode: 'gentle', daily_budget: 3, time_zone: 'Asia/Shanghai', quiet_hours_start: '00:00', quiet_hours_end: '07:00' };
  assert.equal(evaluatePolicy({ profile, relationship: { status: 'warm', metrics: {} }, plans: [], reason: 'morning', at, requestedBubbles: 2 }).reason, 'bubble-limit');
});

test('natural follow-up requires warm relationship', () => {
  const profile = { interaction_mode: 'natural', daily_budget: 3, time_zone: 'Asia/Shanghai', quiet_hours_start: '00:00', quiet_hours_end: '07:00' };
  const plans = [{ status: 'sent', reason: 'morning', scheduled_at: '2026-08-23T00:00:00Z' }];
  assert.equal(evaluatePolicy({ profile, relationship: { status: 'normal', lastPlanReplied: false, metrics: {} }, plans, reason: 'follow-up', at }).reason, 'follow-up-not-eligible');
});

test('clingy follow-up permits normal relationship with an unanswered sent plan', () => {
  const profile = { interaction_mode: 'clingy', daily_budget: 3, time_zone: 'Asia/Shanghai', quiet_hours_start: '00:00', quiet_hours_end: '07:00' };
  const plans = [{ status: 'sent', reason: 'morning', scheduled_at: '2026-08-23T00:00:00Z' }];
  assert.equal(evaluatePolicy({ profile, relationship: { status: 'normal', lastPlanReplied: false, metrics: {} }, plans, reason: 'follow-up', at }).allowed, true);
});

test('unknown and attempted failed plans consume daily budget', () => {
  const profile = { interaction_mode: 'gentle', daily_budget: 1, time_zone: 'Asia/Shanghai', quiet_hours_start: '00:00', quiet_hours_end: '07:00' };
  const plans = [{ status: 'delivery_unknown', has_attempt: 1, scheduled_at: '2026-08-24T08:00:00Z' }];
  assert.equal(evaluatePolicy({ profile, relationship: { status: 'normal', metrics: {} }, plans, reason: 'morning', at }).reason, 'daily-budget-exhausted');
});

test('invalid quiet hours fail closed', () => {
  const profile = { interaction_mode: 'natural', daily_budget: 2, time_zone: 'Asia/Shanghai', quiet_hours_start: '25:00', quiet_hours_end: '07:00' };
  assert.equal(evaluatePolicy({ profile, relationship: { status: 'normal', metrics: {} }, plans: [], reason: 'morning', at }).reason, 'invalid-quiet-hours');
});

test('invalid relationship time returns quiet fail-closed result', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:' });
  assert.equal(core.getRelationship('owner', 'not-a-date').status, 'quiet');
  await core.close();
});

test('profile validation rejects empty owner and display name', async () => {
  const core = await createCompanionCore({ databasePath: ':memory:' });
  assert.throws(() => core.updateProfile('', { daily_budget: 1 }));
  assert.throws(() => core.updateProfile('owner', { display_name: '   ' }));
  assert.doesNotThrow(() => core.updateProfile('owner', { display_name: null }));
  await core.close();
});

test('planProactive rejects expired date window before persistence', async () => {
  const { gateway, registry } = createDshImGateway();
  registry.registerAdapter('a', { health: { status: 'online' }, send: async () => ({ schemaVersion: 1, deliveryOutcome: 'sent' }) });
  const route = registry.upsertTrustedRoute({ channel: 'x', botId: 'b', kind: 'direct', conversationId: 'o', ownerId: 'o', adapterId: 'a', verification: { kind: 'configured-owner', verifiedAt: at } });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway });
  assert.equal((await core.planProactive({ routeId: route.routeId, reason: 'morning', scheduledAt: at, expiresAt: '2026-08-24T11:00:00Z', generated: [{ text: 'x' }] })).reason, 'invalid-date-window');
  await core.close();
});

test('playful angry persona gate rejects normal relationship', () => {
  assert.equal(validatePlayfulAngry({ relationship: { status: 'normal' }, lastPlanReplied: true }), false);
});

test('playful angry persona gate requires latest reply', () => {
  assert.equal(validatePlayfulAngry({ relationship: { status: 'warm' }, lastPlanReplied: false }), false);
});

test('persona output retains explicit text kind and bounded delay', () => {
  const result = normalizeBubbles({ tone: 'warm', bubbles: [{ text: '你好', delayMs: 1000 }] });
  assert.deepEqual(result.bubbles[0], { kind: 'text', text: '你好', delayMs: 1000 });
});

test('persona has equal footing, a point of view, and bounded emotional tones', () => {
  const prompt = buildCompanionPrompt({ profile: { interaction_mode: 'natural' }, relationship: { status: 'warm' } });
  assert.match(prompt, /平等/);
  assert.match(prompt, /不要默认赞同/);
  assert.match(prompt, /opinionated/);
  assert.match(prompt, /playful_angry/);
  assert.match(prompt, /不能羞辱/);
  assert.throws(() => normalizeBubbles({ tone: 'servile', bubbles: [{ text: '好呀' }] }));
  assert.doesNotThrow(() => normalizeBubbles({ tone: 'opinionated', bubbles: [{ text: '这次我不同意你。' }] }));
  assert.doesNotThrow(() => normalizeBubbles({ tone: 'playful_angry', bubbles: [{ text: '哼。' }, { text: '我还在气，但你可以解释。' }] }));
});
