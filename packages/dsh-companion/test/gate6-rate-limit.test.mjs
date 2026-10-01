import assert from 'node:assert/strict';
import test from 'node:test';

import { createDshImGateway } from '../../../src/channels/shared/dsh-im-gateway.mjs';
import { createCompanionCore } from '../src/runtime.mjs';

function fixture(send) {
  const { gateway, registry } = createDshImGateway();
  registry.registerAdapter('rate-limit', { health: { status: 'online' }, capabilities: { text: true }, send });
  const route = registry.upsertTrustedRoute({
    channel: 'memory', botId: 'bot', kind: 'direct', conversationId: 'owner', ownerId: 'owner',
    adapterId: 'rate-limit', verification: { kind: 'configured-owner', verifiedAt: '2026-08-24T00:00:00.000Z' },
  });
  return { gateway, route };
}

test('a definite rate limit is deferred exactly once and then sent', async () => {
  let calls = 0;
  let current = '2026-08-24T04:00:00.000Z';
  const fx = fixture(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('limited'), { code: 'rate_limited', retryAfterMs: 30_000 });
    return { schemaVersion: 1, deliveryOutcome: 'sent' };
  });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fx.gateway, now: () => current });
  const planId = await core.queuePlan({
    routeId: fx.route.routeId, reason: 'morning', scheduledAt: current,
    expiresAt: '2026-08-24T04:05:00.000Z', messages: [{ kind: 'text', text: '早安' }],
  });
  const deferred = await core.runOnce();
  assert.equal(deferred.status, 'planned');
  assert.equal(deferred.retry_count, 1);
  assert.equal(deferred.messages[0].status, 'pending');
  assert.equal(await core.runOnce(), null);
  current = new Date(Date.parse(deferred.retry_scheduled_at) + 1_000).toISOString();
  const delivered = await core.runOnce();
  assert.equal(delivered.status, 'sent');
  assert.equal(delivered.retry_count, 1);
  assert.equal(calls, 2);
  assert.equal(core.inspectPlan(planId).messages[0].status, 'sent');
  await core.close();
});

test('a second definite rate limit becomes final and is never tried a third time', async () => {
  let calls = 0;
  let current = '2026-08-24T04:00:00.000Z';
  const fx = fixture(async () => {
    calls += 1;
    throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 1_000 });
  });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fx.gateway, now: () => current });
  await core.queuePlan({ routeId: fx.route.routeId, reason: 'morning', scheduledAt: current, expiresAt: '2026-08-24T04:05:00.000Z', messages: [{ kind: 'text', text: '早安' }] });
  const deferred = await core.runOnce();
  current = new Date(Date.parse(deferred.retry_scheduled_at) + 1_000).toISOString();
  const failed = await core.runOnce();
  assert.equal(failed.status, 'failed_final');
  assert.equal(failed.messages[0].status, 'failed_final');
  assert.equal(await core.runOnce(), null);
  assert.equal(calls, 2);
  await core.close();
});

test('a rate-limit delay beyond plan expiry fails instead of sending a late greeting', async () => {
  const current = '2026-08-24T04:00:00.000Z';
  const fx = fixture(async () => { throw Object.assign(new Error('limited'), { code: 'http-error', status: 429, retryAfterMs: 60_000 }); });
  const core = await createCompanionCore({ databasePath: ':memory:', gateway: fx.gateway, now: () => current });
  await core.queuePlan({ routeId: fx.route.routeId, reason: 'morning', scheduledAt: current, expiresAt: '2026-08-24T04:00:30.000Z', messages: [{ kind: 'text', text: '早安' }] });
  const failed = await core.runOnce();
  assert.equal(failed.status, 'failed_final');
  assert.equal(failed.retry_count, 0);
  await core.close();
});
