import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { QqRuntime } from '../../../src/channels/qq/qq-runtime.mjs';
import { rememberConnectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';
import { createDshImGateway } from '../../../src/channels/shared/dsh-im-gateway.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeBot extends EventEmitter {
  middlewares = [];
  sent = [];
  images = [];
  stopped = false;
  use(value) { this.middlewares.push(value); }
  async start(signal) {
    queueMicrotask(() => this.emit('ready', {}));
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  }
  stop() { this.stopped = true; }
  async sendText(target, text) { this.sent.push({ target, text }); }
  async sendImage(target, source) {
    this.images.push({ target, bytes: Buffer.from(source.buffer) });
    return { message: { id: `image-${this.images.length}` } };
  }
}

function gatewayState() {
  return {
    hasSeen: () => false,
    markSeen: async () => {},
    sessionFor: () => null,
    setSession: async () => {},
    clearSession: async () => {},
  };
}

test('QQ runtime waits for gateway ready, installs typing, and stops its client', async () => {
  const bot = new FakeBot();
  let botOptions;
  const sdkLogs = [];
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createBot: (options) => {
      botOptions = options;
      return bot;
    },
    logger: {
      debug: (...args) => sdkLogs.push(['debug', ...args]),
      info: (...args) => sdkLogs.push(['info', ...args]),
    },
    typingMiddleware: (options) => ({ name: 'typing-middleware', options }),
    connectTimeoutMs: 100,
  });
  const status = await runtime.start();
  assert.equal(status.ready, true);
  assert.equal(status.qqConnectionState, 'connected');
  assert.equal(bot.middlewares[0].name, 'typing-middleware');
  assert.equal(bot.middlewares[0].options.keepAlive, true);
  assert.equal(bot.middlewares[0].options.predicate({ message: { senderId: 'owner' } }), true);
  assert.equal(bot.middlewares[0].options.predicate({ message: { senderId: 'other' } }), false);
  botOptions.logger.debug('raw gateway payload');
  botOptions.logger.info('gateway ready');
  assert.deepEqual(sdkLogs, [['info', 'gateway ready']]);
  bot.emit('error', new Error('temporary disconnect'));
  bot.emit('resumed');
  assert.equal(runtime.status.ready, true);
  assert.equal(runtime.status.lastError, null);
  await runtime.stop();
  assert.equal(bot.stopped, true);
  assert.equal(runtime.status.ready, false);
});

test('QQ runtime never reports ready when the gateway does not emit ready', async () => {
  const bot = new FakeBot();
  bot.start = async (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 5,
  });
  await assert.rejects(() => runtime.start(), /did not become ready/);
  assert.equal(runtime.status.ready, false);
});

test('QQ runtime sends a proactive connection test to the explicit owner fallback', async () => {
  const bot = new FakeBot();
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner-openid' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
  });

  await runtime.start();
  assert.deepEqual(await runtime.sendConnectionTest('connection-test'), { sent: true });
  assert.deepEqual(bot.sent, [{
    target: { scope: 'c2c', targetId: 'owner-openid' },
    text: 'connection-test',
  }]);
  await runtime.stop();
});

test('QQ runtime requires a remembered private target for wildcard owners and strips the reply id', async () => {
  const bot = new FakeBot();
  const state = {};
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: '*' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state,
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
  });

  await runtime.start();
  await assert.rejects(
    () => runtime.sendConnectionTest('unavailable'),
    (error) => error?.code === 'test-target-unavailable',
  );
  rememberConnectionTestTarget(state, {
    scope: 'c2c', targetId: 'recent-user', msgId: 'old-inbound-message',
  });
  await runtime.sendConnectionTest('remembered-target');
  assert.deepEqual(bot.sent, [{
    target: { scope: 'c2c', targetId: 'recent-user' },
    text: 'remembered-target',
  }]);
  await runtime.stop();
});

test('QQ gateway routes proactive text and stickers only to the explicit trusted owner', async () => {
  const bot = new FakeBot();
  const { gateway, registry } = createDshImGateway();
  const runtime = new QqRuntime({
    config: { botId: 'qq_gateway', appId: 'app', ownerUserOpenid: 'trusted-owner' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: gatewayState(),
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
    dshImGatewayRegistry: registry,
  });

  await runtime.start();
  bot.emit('message', {}, {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'trusted-owner',
    senderIsBot: false,
    content: '/help',
    messageId: 'owner-inbound',
    replyTarget: { scope: 'c2c', targetId: 'trusted-owner', msgId: 'owner-inbound' },
  });
  const route = gateway.listRoutes()[0];
  assert.equal(route.ownerId, 'trusted-owner');
  assert.equal(route.inboundVersion, 1);

  const textReceipt = await gateway.send(route.routeId, { kind: 'text', text: '主动问候' }, {
    idempotencyKey: 'qq-text-1',
  });
  const stickerReceipt = await gateway.send(route.routeId, {
    kind: 'sticker',
    stickerId: 'hug',
    file: { fileName: 'hug.png', bytes: Buffer.from('image') },
  }, { idempotencyKey: 'qq-sticker-1' });
  assert.equal(textReceipt.presentation, 'qq-proactive-text');
  assert.equal(stickerReceipt.presentation, 'qq-proactive-image');
  assert.deepEqual(bot.sent.find(({ text }) => text === '主动问候')?.target, {
    scope: 'c2c', targetId: 'trusted-owner',
  });
  assert.deepEqual(bot.images[0].target, { scope: 'c2c', targetId: 'trusted-owner' });
  await runtime.stop();
  assert.equal(gateway.getRoute(route.routeId).status, 'revoked');
});

test('QQ wildcard owner never creates a proactive gateway route', async () => {
  const bot = new FakeBot();
  const { gateway, registry } = createDshImGateway();
  const runtime = new QqRuntime({
    config: { botId: 'qq_wildcard_gateway', appId: 'app', ownerUserOpenid: '*' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: gatewayState(),
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
    dshImGatewayRegistry: registry,
  });
  await runtime.start();
  bot.emit('message', {}, {
    kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'someone', senderIsBot: false,
    content: '/help', messageId: 'wildcard-inbound',
    replyTarget: { scope: 'c2c', targetId: 'someone', msgId: 'wildcard-inbound' },
  });
  assert.deepEqual(gateway.listRoutes(), []);
  await runtime.stop();
});

test('QQ runtime aborts an in-flight Harness interaction when stopped', async () => {
  const bot = new FakeBot();
  const askStarted = deferred();
  let askSignal;
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner' },
    appSecret: 'secret',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        askSignal = options.signal;
        askStarted.resolve();
        await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
          reject(options.signal.reason);
        }, { once: true }));
      },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-existing',
      setSession: async () => {},
      clearSession: async () => {},
    },
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
    logger: { error() {}, warn() {}, info() {} },
  });

  await runtime.start();
  bot.emit('message', {}, {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner',
    senderIsBot: false,
    content: '需要交互',
    messageId: 'interaction-message',
    replyTarget: { scope: 'c2c', targetId: 'owner', msgId: 'interaction-message' },
  });
  await askStarted.promise;
  assert.equal(askSignal.aborted, false);
  bot.emit('message', {}, {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner',
    senderIsBot: false,
    content: '排队中的下一条消息',
    messageId: 'queued-message',
    replyTarget: { scope: 'c2c', targetId: 'owner', msgId: 'queued-message' },
  });
  await runtime.stop();
  assert.equal(askSignal.aborted, true);
});

test('QQ runtime enables result-file delivery without per-bot configuration', async () => {
  const bot = new FakeBot();
  const finished = deferred();
  let onArtifact;
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner' },
    appSecret: 'secret',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        onArtifact = options.onArtifact;
        return '完成';
      },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => finished.resolve(),
      sessionFor: () => 'session-existing',
      setSession: async () => {},
      clearSession: async () => {},
    },
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
  });

  await runtime.start();
  bot.emit('message', {}, {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner',
    senderIsBot: false,
    content: '生成文件',
    messageId: 'qq-artifact-gate',
    replyTarget: { scope: 'c2c', targetId: 'owner', msgId: 'qq-artifact-gate' },
  });
  await finished.promise;
  assert.equal(typeof onArtifact, 'function');
  await runtime.stop();
});
