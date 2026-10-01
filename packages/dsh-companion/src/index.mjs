import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCompanionCore } from './runtime.mjs';
import { createHarnessGenerator, createOpenAICompatibleGenerator } from './generator.mjs';
import { createHarnessMemoryExtractor, createOpenAICompatibleMemoryExtractor } from './memory-extractor.mjs';
import { createHarnessTopicProvider } from './topic.mjs';
import { createStickerCatalog, importStickerDirectory } from './sticker.mjs';
import { createStickerCapture } from './sticker-capture.mjs';
import { createHarnessStickerAnnotator, createStickerAnnotator } from './sticker-annotator.mjs';
import { installCompanionSystemPrompt } from './system-prompt.mjs';

export const name = 'dsh-companion';
export const inject = [];

export function bundledCompanionPresetPath() {
  return fileURLToPath(new URL('../presets/companion/', import.meta.url));
}

export async function syncCompanionPreset({ dshHome, sourceDir = bundledCompanionPresetPath() } = {}) {
  const home = resolve(dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const targetDir = join(home, '.agent-presets', 'companion');
  await mkdir(targetDir, { recursive: true });
  await Promise.all(['agent.cordis.yml', 'preset.yml'].map((filename) => (
    copyFile(join(sourceDir, filename), join(targetDir, filename))
  )));
  const skillTargetDir = join(home, 'skills', 'dsh-companion-humor');
  await mkdir(skillTargetDir, { recursive: true });
  await copyFile(
    join(sourceDir, 'skills', 'dsh-companion-humor', 'SKILL.md'),
    join(skillTargetDir, 'SKILL.md'),
  );
  return targetDir;
}

export function createCompanionHarnessSessionPool(harness) {
  if (!harness || typeof harness.createSession !== 'function' || typeof harness.ask !== 'function') {
    throw new TypeError('companion Harness session pool requires createSession and ask');
  }
  const sessions = new Map();
  const keyFor = (options = {}) => {
    if (typeof options.purpose === 'string' && options.purpose.trim()) return options.purpose.trim();
    if (typeof options.windowKind === 'string' && options.windowKind.trim()) return 'companion-generation';
    return 'companion-general';
  };
  return {
    async createSession(options = {}) {
      const key = keyFor(options);
      let pending = sessions.get(key);
      if (pending) {
        const sessionId = await pending;
        if (typeof harness.sessionExists !== 'function' || await harness.sessionExists(sessionId)) return sessionId;
        if (sessions.get(key) === pending) sessions.delete(key);
      }
      pending = Promise.resolve(harness.createSession(options));
      sessions.set(key, pending);
      try {
        return await pending;
      } catch (error) {
        if (sessions.get(key) === pending) sessions.delete(key);
        throw error;
      }
    },
    async ask(...args) {
      try {
        return await harness.ask(...args);
      } catch (error) {
        if (error?.code === 'session-not-found') sessions.clear();
        throw error;
      }
    },
  };
}

export function defaultDatabasePath(config = {}) {
  const root = resolve(config.dataDir ?? join(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'integrations', 'dsh-companion'));
  return config.databasePath ?? join(root, 'companion.sqlite3');
}

export async function createCompanionPlugin(ctx, config = {}) {
  if (config.preset?.enabled === true) {
    const presetPath = await syncCompanionPreset({ dshHome: config.dshHome });
    const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : ctx?.logger;
    logger?.info?.(`companion agent preset synced to ${presetPath}`);
  }
  let generator = config.generator;
  if (generator !== undefined && typeof generator.generate !== 'function' && generator?.type !== 'openai-compatible') throw new TypeError('unknown generator configuration');
  if (config.generator?.type === 'openai-compatible') { if (!config.generator.baseUrl || !config.generator.model || !config.generator.apiKeyEnv || !process.env[config.generator.apiKeyEnv]) throw new TypeError('OpenAI-compatible generator configuration is incomplete'); generator = createOpenAICompatibleGenerator({ ...config.generator, apiKey: process.env[config.generator.apiKeyEnv] }); }
  let memoryExtractor = config.memoryExtractor;
  if (memoryExtractor !== undefined && typeof memoryExtractor.extract !== 'function' && memoryExtractor?.type !== 'openai-compatible') throw new TypeError('unknown memory extractor configuration');
  if (memoryExtractor?.type === 'openai-compatible') { if (!memoryExtractor.baseUrl || !memoryExtractor.model || !memoryExtractor.apiKeyEnv || !process.env[memoryExtractor.apiKeyEnv]) throw new TypeError('OpenAI-compatible memory extractor configuration is incomplete'); memoryExtractor = createOpenAICompatibleMemoryExtractor({ ...memoryExtractor, apiKey: process.env[memoryExtractor.apiKeyEnv] }); }
  let stickerCatalog = config.stickerCatalog;
  if (!stickerCatalog && config.stickers?.enabled === true) {
    if (!config.stickers.rootDir || !config.stickers.manifestPath) throw new TypeError('sticker catalog paths are required');
    if (config.stickers.autoImport === true) await importStickerDirectory({ sourceDir: config.stickers.inboxDir ?? join(config.stickers.rootDir, 'inbox'), rootDir: config.stickers.rootDir, manifestPath: config.stickers.manifestPath });
    stickerCatalog = await createStickerCatalog({ rootDir: config.stickers.rootDir, manifestPath: config.stickers.manifestPath, cooldownMs: config.stickers.cooldownMs });
  }
  const core = await createCompanionCore({ databasePath: defaultDatabasePath(config), generator, topicProvider: config.topicProvider, stickerCatalog, memoryExtractor, replySticker: config.stickers?.reply });
  if (config.worker?.enabled === true) core.startWorker(config.worker);
  let attached = null;
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : (ctx?.logger ?? console);
  let currentStickerAnnotator = config.stickers?.capture?.annotator ?? createStickerAnnotator({ logger });
  const stickerCapture = stickerCatalog && typeof stickerCatalog.addBuffer === 'function' && config.stickers?.capture?.enabled !== false
    ? createStickerCapture({ stickerCatalog, annotator: { annotate: (input) => currentStickerAnnotator.annotate(input) }, logger })
    : null;
  const attach = async (gateway) => {
    if (!gateway || gateway === attached) return undefined;
    attached = gateway;
    await core.attachGateway(gateway);
    const offCapture = stickerCapture && typeof gateway.onInboundHandler === 'function'
      ? gateway.onInboundHandler((event) => stickerCapture.handle(event)) : null;
    return async () => { offCapture?.(); if (attached === gateway) { attached = null; await core.detachGateway(); } };
  };
  if (typeof ctx?.provide === 'function') ctx.provide('dshCompanion', core);
  const attachHarness = (harness) => {
    if (!harness) return;
    const pooledHarness = createCompanionHarnessSessionPool(harness);
    core.setProviders({
      ...(generator ? {} : { generator: createHarnessGenerator({ harness: pooledHarness }) }),
    ...(config.topicProvider ? {} : { topicProvider: createHarnessTopicProvider({ harness: pooledHarness }) }),
      ...(memoryExtractor ? {} : { memoryExtractor: createHarnessMemoryExtractor({ harness: pooledHarness }) }),
    });
    if (!config.stickers?.capture?.annotator && stickerCapture) {
      currentStickerAnnotator = createHarnessStickerAnnotator({ harness: pooledHarness, logger });
    }
  };
  if (typeof ctx?.inject === 'function') ctx.inject(['dshCompanionHarness'], (scope) => attachHarness(scope?.dshCompanionHarness ?? scope));
  if (config.systemPrompt?.enabled !== false) {
    if (typeof ctx?.inject === 'function') ctx.inject(['systemPrompt'], (scope) => installCompanionSystemPrompt(scope));
  }
  if (typeof ctx?.inject === 'function') ctx.inject(['dshImGateway'], (scope) => attach(scope?.dshImGateway ?? scope));
  if (typeof ctx?.effect === 'function') ctx.effect(() => async () => { await core.close(); });
  return core;
}

export async function apply(ctx, config = {}) { await createCompanionPlugin(ctx, config); }
export { createCompanionCore } from './runtime.mjs';
