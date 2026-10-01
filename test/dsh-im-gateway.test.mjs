import assert from 'node:assert/strict';
import test from 'node:test';

import { createDshImGateway } from '../src/channels/shared/dsh-im-gateway.mjs';

function fixture(options) {
  const sent = [];
  const { gateway, registry } = createDshImGateway(options);
  registry.registerAdapter('wechat', {
    capabilities: { text: true, image: true },
    health: { status: 'ok' },
    send: async (route, message, sendOptions) => {
      sent.push({ route, message, sendOptions });
      return { status: 'sent', messageId: 'm-1' };
    },
  });
  const route = registry.upsertTrustedRoute({ channel: 'weixin', botId: 'bot', kind: 'direct', conversationId: 'user', adapterId: 'wechat', ownerId: 'owner', sessionId: 'session', verification: { kind: 'configured-owner', verifiedAt: '2026-08-24T00:00:00.000Z' } });
  return { gateway, registry, route, sent };
}

test('gateway exposes cloned routes and adapter capabilities/health', async () => {
  const { gateway, route } = fixture();
  const copy = gateway.getRoute(route.routeId);
  copy.status = 'revoked';
  assert.equal(gateway.getRoute(route.routeId).status, 'active');
  assert.deepEqual(await gateway.getCapabilities(route.routeId), { text: true, image: true });
  assert.deepEqual(await gateway.getHealth(route.routeId), { status: 'ok' });
});

test('listRoutes returns deterministic cloned snapshots including revoked routes', () => {
  const { gateway, registry, route } = fixture();
  const second = registry.upsertTrustedRoute({ ...route, conversationId: 'other' });
  registry.revokeRoute(route.routeId);
  const listed = gateway.listRoutes();
  listed[0].status = 'active';
  assert.deepEqual(listed.map((item) => item.routeId), [...listed].map((item) => item.routeId).sort((a, b) => a.localeCompare(b)));
  assert.equal(gateway.getRoute(route.routeId).status, 'revoked');
  assert.equal(gateway.getRoute(second.routeId).status, 'active');
});

test('getJournalState exposes clone-safe cursor and retention state', () => {
  const { gateway, registry, route } = fixture({ capacity: 2 });
  registry.recordInbound(route.routeId, { messageId: 'j1' });
  registry.recordInbound(route.routeId, { messageId: 'j2' });
  const state = gateway.getJournalState();
  assert.deepEqual(state, { currentCursor: '2', oldestCursor: '1', retentionMs: 90 * 24 * 60 * 60 * 1000, capacity: 2 });
  state.currentCursor = 'attacker';
  assert.equal(gateway.getJournalState().currentCursor, '2');
});

test('send requires idempotency and rejects unknown, revoked, and non-direct routes', async () => {
  const { gateway, registry, route, sent } = fixture();
  await assert.rejects(() => gateway.send(route.routeId, { text: 'hi' }), /idempotencyKey/);
  await assert.rejects(() => gateway.send('missing', {}, { idempotencyKey: 'x' }), (error) => error.code === 'unknown_route');
  await gateway.send(route.routeId, { text: 'hi' }, { idempotencyKey: 'x' });
  assert.equal(sent.length, 1);
  registry.revokeRoute(route.routeId);
  await assert.rejects(() => gateway.send(route.routeId, {}, { idempotencyKey: 'y' }), (error) => error.code === 'inactive_route');
  assert.throws(() => registry.upsertTrustedRoute({ channel: 'x', botId: 'b', kind: 'group', conversationId: 'g', adapterId: 'wechat', ownerId: 'owner', verification: { kind: 'configured-owner', verifiedAt: 'now' } }), /direct routes/);
});

test('inbound journal is ordered, metadata-only, and detects control intents after lost callbacks', () => {
  const { gateway, registry, route } = fixture({ capacity: 2 });
  const live = [];
  gateway.onInbound((event) => live.push(event));
  registry.recordInbound(route.routeId, { messageId: 'a', normalizedText: 'hello' });
  registry.recordInbound(route.routeId, { messageId: 'b', normalizedText: '/companion pause' });
  registry.recordInbound(route.routeId, { messageId: 'c', normalizedText: 'secret' });
  assert.equal(live.length, 3);
  assert.equal(live[1].controlIntent, 'pause_proactive');
  assert.equal(gateway.getRoute(route.routeId).inboundVersion, 3);
  const replay = gateway.readInboundSince('1', 10);
  assert.deepEqual(replay.events.map((event) => event.messageId), ['b', 'c']);
  assert.equal(replay.events[0].controlIntent, 'pause_proactive');
  assert.equal('normalizedText' in replay.events[0], false);
  assert.throws(() => gateway.readInboundSince('0', 10), (error) => error.code === 'cursor_expired');
});

test('route versions increase on refresh/revoke and subscriptions can be removed', () => {
  const { gateway, registry, route } = fixture();
  const changes = [];
  const off = gateway.onRouteChanged((event) => changes.push(event));
  const refreshed = registry.upsertTrustedRoute({ ...route });
  assert.equal(refreshed.routeVersion, 2);
  off();
  registry.revokeRoute(route.routeId);
  assert.equal(changes.length, 1);
  assert.equal(gateway.getRoute(route.routeId).status, 'revoked');
});

test('conversation reply events are live-only and carry the current route versions', () => {
  const { gateway, registry, route } = fixture();
  const replies = [];
  const off = gateway.onConversationReply((event) => replies.push(event));
  registry.recordInbound(route.routeId, { messageId: 'in-1', normalizedText: '笑死我了' });
  const event = registry.recordConversationReply(route.routeId, { messageId: 'in-1', inputText: '笑死我了', outputText: '你先别笑，我也绷不住了' });
  off();
  registry.recordConversationReply(route.routeId, { messageId: 'in-2', inputText: '第二句', outputText: '第二条回复' });
  assert.equal(replies.length, 1);
  assert.equal(event.inboundVersion, 1);
  assert.equal(event.routeVersion, 1);
  assert.equal(gateway.readInboundSince('0').events.length, 1);
});

test('route identity is derived from normalized identity fields and internal fields cannot be overridden', () => {
  const { registry, route, gateway } = fixture();
  const refreshed = registry.upsertTrustedRoute({
    ...route,
    routeId: 'attacker-route', status: 'revoked', routeVersion: 900, inboundVersion: 900,
    createdAt: 'attacker-time', ownerId: 'owner-2',
    verification: { kind: 'qr-bound-owner', verifiedAt: '2026-08-25T00:00:00.000Z' },
  });
  assert.equal(refreshed.routeId, route.routeId);
  assert.equal(refreshed.status, 'active');
  assert.equal(refreshed.routeVersion, 2);
  assert.equal(refreshed.inboundVersion, 0);
  assert.equal(refreshed.createdAt, route.createdAt);
  assert.equal(refreshed.ownerId, 'owner-2');
  assert.deepEqual(refreshed.verification, { kind: 'qr-bound-owner', verifiedAt: '2026-08-25T00:00:00.000Z' });
  assert.equal(gateway.getRoute('attacker-route'), null);
});

test('unregistering an adapter revokes its active routes and blocks delivery', async () => {
  const { gateway, registry, route } = fixture();
  assert.equal(registry.unregisterAdapter('wechat'), true);
  assert.equal(gateway.getRoute(route.routeId).status, 'revoked');
  await assert.rejects(() => gateway.send(route.routeId, { text: 'x' }, { idempotencyKey: 'k' }), (error) => error.code === 'inactive_route');
});

test('inbound handlers receive live lazy images without adding them to journal', async () => {
  const { gateway, registry, route } = fixture();
  const image = { load: async () => Buffer.from('image') };
  const seen = [];
  const off = gateway.onInboundHandler(async (event) => {
    seen.push(event);
    return { handled: event.normalizedText === '/bqb', replies: ['ok'] };
  });
  const result = await registry.dispatchInbound(route.routeId, { messageId: 'img-1', normalizedText: '/bqb', images: [image] });
  off();
  assert.deepEqual(result, { handled: true, replies: ['ok'] });
  assert.equal(seen[0].images[0], image);
  assert.equal(gateway.readInboundSince('0').events.length, 0);
});

test('handler errors fail open to the legacy path', async () => {
  const { gateway, registry, route } = fixture();
  gateway.onInboundHandler(async () => { throw new Error('optional handler failed'); });
  assert.deepEqual(await registry.dispatchInbound(route.routeId, { normalizedText: 'ordinary' }), { handled: false, replies: [] });
});
