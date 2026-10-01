import { QQBot, typingIndicator } from '@tencent-connect/qqbot-nodejs';

import {
  connectionTestTarget,
  connectionTestTargetUnavailable,
} from '../shared/connection-test.mjs';
import { t } from '../shared/i18n.mjs';
import { createDeliveryReceipt, providerMessageIdsFor } from '../shared/semantic/delivery.mjs';
import { createQqBridgeStatus, QqHarnessBridge } from './qq-bridge.mjs';

function timeoutError() {
  const error = new Error('QQ WebSocket did not become ready in time');
  error.code = 'connect-timeout';
  return error;
}

export function createQqRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    qqConnectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    ...createQqBridgeStatus(),
  };
}

export class QqRuntime {
  #config;
  #appSecret;
  #harness;
  #state;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #connectTimeoutMs;
  #createBot;
  #typingMiddleware;
  #status = createQqRuntimeStatus();
  #bot = null;
  #bridge = null;
  #abortController = null;
  #runTask = null;
  #starting = null;
  #gatewayRegistry;
  #adapterId;
  #adapterUnregister = null;

  constructor({
    config,
    appSecret,
    harness,
    state,
    logger = console,
    replyTimeoutMs = 600_000,
    maxMessageChars = 4_000,
    connectTimeoutMs = 20_000,
    createBot = (options) => new QQBot(options),
    typingMiddleware = typingIndicator,
    dshImGatewayRegistry,
  }) {
    if (!config || !appSecret || !harness || !state) {
      throw new TypeError('QqRuntime requires config, app secret, Harness, and state');
    }
    this.#config = config;
    this.#appSecret = appSecret;
    this.#harness = harness;
    this.#state = state;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#createBot = createBot;
    this.#typingMiddleware = typingMiddleware;
    this.#gatewayRegistry = dshImGatewayRegistry;
    this.#adapterId = `qq:${this.#config.botId}`;
  }

  get status() {
    return structuredClone(this.#status);
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#bot) {
      throw connectionTestTargetUnavailable(t('QQ机器人'));
    }
    const ownerUserOpenid = typeof this.#config.ownerUserOpenid === 'string'
      ? this.#config.ownerUserOpenid.trim()
      : '';
    const remembered = connectionTestTarget(this.#state);
    const rememberedUserOpenid = remembered?.scope === 'c2c'
      && typeof remembered.targetId === 'string'
      ? remembered.targetId.trim()
      : '';
    const target = rememberedUserOpenid
      ? { scope: 'c2c', targetId: rememberedUserOpenid }
      : (ownerUserOpenid && ownerUserOpenid !== '*'
        ? { scope: 'c2c', targetId: ownerUserOpenid }
        : null);
    if (!target) throw connectionTestTargetUnavailable(t('QQ机器人'));
    await this.#bot.sendText(target, text);
    return { sent: true };
  }

  async start() {
    if (this.#status.ready && this.#bot) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    await this.stop();
    this.#status.startedAt = new Date().toISOString();
    this.#status.qqConnectionState = 'connecting';
    this.#status.lastError = null;
    await this.#harness.ensureRunning();
    this.#status.harnessReachable = true;

    const sdkLogger = {
      error: (...args) => this.#logger.error?.(...args),
      warn: (...args) => this.#logger.warn?.(...args),
      info: (...args) => this.#logger.info?.(...args),
      debug: () => {},
    };
    const bot = this.#createBot({
      appId: this.#config.appId,
      appSecret: this.#appSecret,
      accountId: this.#config.botId,
      logger: sdkLogger,
      transport: 'websocket',
      tokenPrefetch: 'sync',
    });
    if (!bot || typeof bot.start !== 'function' || typeof bot.stop !== 'function') {
      throw new TypeError('QQ bot factory returned an invalid client');
    }
    const controller = new AbortController();
    this.#abortController = controller;
    this.#bot = bot;
    this.#bridge = new QqHarnessBridge({
      bot,
      ownerUserOpenid: this.#config.ownerUserOpenid,
      harness: this.#harness,
      state: this.#state,
      status: this.#status,
      logger: this.#logger,
      replyTimeoutMs: this.#replyTimeoutMs,
      maxMessageChars: this.#maxMessageChars,
      signal: controller.signal,
      dshImGatewayRegistry: this.#gatewayRegistry,
      botId: this.#config.botId,
    });
    if (this.#gatewayRegistry) {
      this.#adapterUnregister = this.#gatewayRegistry.registerAdapter(this.#adapterId, {
        capabilities: {
          text: true,
          image: typeof bot.sendImage === 'function',
          sticker: typeof bot.sendImage === 'function',
          idempotency: 'local-at-most-once',
        },
        getHealth: () => ({ status: this.#status.ready ? 'online' : 'offline' }),
        send: (route, message, options) => this.#sendProactive(route, message, options),
      });
    }
    bot.use?.(this.#typingMiddleware({
      keepAlive: true,
      predicate: (ctx) => this.#config.ownerUserOpenid === '*'
        || ctx?.message?.senderId === this.#config.ownerUserOpenid,
    }));

    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const onReady = () => {
      const now = Date.now();
      this.#status.ready = true;
      this.#status.qqConnectionState = 'connected';
      this.#status.lastCheckedAt = now;
      this.#status.lastConnectedAt = now;
      this.#status.lastError = null;
      readyResolve();
    };
    const onError = (error) => {
      if (!this.#status.ready) readyReject(error);
      else {
        this.#status.lastError = error?.message ?? String(error);
        this.#logger.warn?.(`[dsh-im:qq] bot ${this.#config.botId} connection error:`, error);
      }
    };
    const onMessage = (_ctx, message) => {
      const task = this.#bridge?.accept(message);
      if (!task) return;
      void task.catch((error) => {
        if (controller.signal.aborted) return;
        this.#logger.error?.(
          `[dsh-im:qq] bot ${this.#config.botId} message handling failed:`,
          error,
        );
      });
    };
    bot.on('ready', onReady);
    bot.on('resumed', onReady);
    bot.on('error', onError);
    bot.on('message', onMessage);

    const runTask = Promise.resolve().then(() => bot.start(controller.signal));
    this.#runTask = runTask;
    runTask.catch((error) => {
      if (controller.signal.aborted) return;
      readyReject(error);
      this.#status.ready = false;
      this.#status.qqConnectionState = 'failed';
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.(`[dsh-im:qq] bot ${this.#config.botId} connection stopped:`, error);
    });

    let timer;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), this.#connectTimeoutMs);
        }),
      ]);
      this.#status.ready = true;
      this.#status.qqConnectionState = 'connected';
      this.#status.lastCheckedAt = Date.now();
      this.#status.lastConnectedAt = Date.now();
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.qqConnectionState = 'failed';
      this.#status.lastError = error?.message ?? String(error);
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop() {
    const bot = this.#bot;
    const bridge = this.#bridge;
    const runTask = this.#runTask;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#bot = null;
    this.#bridge = null;
    this.#runTask = null;
    this.#adapterUnregister?.();
    this.#adapterUnregister = null;
    try {
      bot?.stop();
    } catch (error) {
      this.#logger.warn?.(`[dsh-im:qq] bot ${this.#config.botId} failed to stop cleanly:`, error);
    }
    await Promise.race([
      runTask?.catch(() => undefined) ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await bridge?.waitForIdle();
    this.#status.ready = false;
    this.#status.qqConnectionState = 'idle';
    return this.status;
  }

  async #sendProactive(route, message, options = {}) {
    if (!this.#status.ready || !this.#bot || !this.#abortController) {
      const error = new Error('QQ runtime is not connected');
      error.code = 'adapter_unavailable';
      throw error;
    }
    const ownerUserOpenid = typeof this.#config.ownerUserOpenid === 'string'
      ? this.#config.ownerUserOpenid.trim()
      : '';
    if (!ownerUserOpenid || ownerUserOpenid === '*' || !route
      || route.channel !== 'qq' || route.kind !== 'direct'
      || route.botId !== this.#config.botId || route.conversationId !== ownerUserOpenid
      || route.ownerId !== ownerUserOpenid || route.routeId !== this.#bridge?.gatewayRouteId) {
      const error = new Error('QQ proactive route is not trusted');
      error.code = 'inactive_route';
      throw error;
    }
    const key = options.idempotencyKey;
    if (typeof key !== 'string' || !key.trim()) {
      throw new TypeError('idempotencyKey must be a non-empty string');
    }
    const target = { scope: 'c2c', targetId: ownerUserOpenid };
    const presentation = message?.kind === 'text' ? 'qq-proactive-text' : 'qq-proactive-image';
    try {
      if (message?.kind === 'text' && typeof message.text === 'string' && message.text.trim()) {
        const result = await this.#bot.sendText(target, message.text.trim());
        return createDeliveryReceipt({
          deliveryId: key,
          presentation,
          providerMessageIds: providerMessageIdsFor(result),
          deliveryOutcome: 'sent',
        });
      }
      if ((message?.kind === 'image' || message?.kind === 'sticker')
        && message.file && typeof message.file.fileName === 'string' && message.file.fileName.trim()
        && (Buffer.isBuffer(message.file.bytes) || message.file.bytes instanceof Uint8Array)
        && typeof this.#bot.sendImage === 'function') {
        const bytes = Buffer.from(message.file.bytes);
        if (bytes.byteLength === 0) throw new TypeError('proactive image file bytes must be non-empty');
        const result = await this.#bot.sendImage(
          target,
          { buffer: bytes },
          { onProgress: () => this.#abortController?.signal.throwIfAborted() },
        );
        return createDeliveryReceipt({
          deliveryId: key,
          presentation,
          providerMessageIds: providerMessageIdsFor(result),
          deliveryOutcome: 'sent',
          artifacts: [{ artifactId: message.stickerId ?? message.file.fileName, outcome: 'sent' }],
        });
      }
      throw new TypeError('Unsupported proactive QQ message');
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
      if (['artifact-delivery-uncertain', 'network-error', 'timeout', 'invalid-response'].includes(error?.code)) {
        return createDeliveryReceipt({
          deliveryId: key,
          presentation,
          deliveryOutcome: 'unknown',
          reason: error.code,
          artifacts: message?.kind === 'text' ? [] : [{
            artifactId: message?.stickerId ?? message?.file?.fileName ?? key,
            outcome: 'unknown',
            reason: error.code,
          }],
        });
      }
      throw error;
    }
  }
}
