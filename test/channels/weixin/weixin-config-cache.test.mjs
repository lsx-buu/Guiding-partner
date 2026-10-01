import assert from 'node:assert/strict';
import test from 'node:test';

import { createWeixinConfigCache } from '../../../src/channels/weixin/weixin-config-cache.mjs';

test('Weixin config cache stores tickets for a day and refreshes after expiry', async () => {
  let now = 0;
  let loads = 0;
  const cache = createWeixinConfigCache({ clock: () => now });
  const load = async () => { loads += 1; return { typing_ticket: `ticket-${loads}` }; };
  assert.equal(await cache.getTypingTicket('user', 'context-1', load), 'ticket-1');
  assert.equal(await cache.getTypingTicket('user', 'context-2', load), 'ticket-1');
  now += 24 * 60 * 60 * 1_000;
  assert.equal(await cache.getTypingTicket('user', 'context-3', load), 'ticket-2');
  assert.equal(loads, 2);
});

test('Weixin config cache backs off failures exponentially and never throws', async () => {
  let now = 0;
  let loads = 0;
  const cache = createWeixinConfigCache({ clock: () => now });
  const load = async () => { loads += 1; throw new Error('provider failure'); };
  assert.equal(await cache.getTypingTicket('user', 'context', load), '');
  assert.equal(await cache.getTypingTicket('user', 'context', load), '');
  assert.equal(loads, 1);
  now += 2_000;
  assert.equal(await cache.getTypingTicket('user', 'context', load), '');
  assert.equal(loads, 2);
  now += 3_999;
  assert.equal(await cache.getTypingTicket('user', 'context', load), '');
  assert.equal(loads, 2);
  now += 1;
  assert.equal(await cache.getTypingTicket('user', 'context', load), '');
  assert.equal(loads, 3);
});
