#!/usr/bin/env node
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCompanionCore } from './runtime.mjs';
import { defaultDatabasePath } from './index.mjs';
import { defaultStickerRoot, importStickerDirectory, initializeStickerDirectory } from './sticker.mjs';
import { collectChineseBqb } from './sticker-collector.mjs';

export const CLEAR_BOUNDARY = '不会撤回或改写 Harness Session、已发 IM、外部 provider 或备份中的数据';

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new TypeError(`${name} 需要一个路径`);
  return value;
}

export async function runCli(argv = process.argv.slice(2), { service } = {}) {
  const [group, action, ownerId, memoryId] = argv;
  if (group === 'stickers') {
    const rootDir = optionValue(argv, '--root') ?? defaultStickerRoot();
    const manifestPath = optionValue(argv, '--manifest') ?? join(rootDir, 'stickers.json');
    if (action === 'init') return initializeStickerDirectory({ rootDir, manifestPath });
    if (action === 'import') return importStickerDirectory({ sourceDir: ownerId, rootDir, manifestPath });
    if (action === 'collect') {
      const value = optionValue(argv, '--limit');
      const limit = value === undefined ? 72 : Number(value);
      return collectChineseBqb({ rootDir, manifestPath, limit });
    }
    throw new Error('不支持的表情包命令');
  }

  const core = service ?? await createCompanionCore({ databasePath: process.env.DSH_COMPANION_DB ?? defaultDatabasePath() });
  try {
    if (group === 'profile' && action === 'show') return core.getProfile(ownerId);
    if (group === 'memory' && action === 'list') return core.listMemories({ ownerId });
    if (group === 'memory' && action === 'export') return core.exportMemories(ownerId);
    if (group === 'memory' && ['forget', 'erase'].includes(action)) { if (!argv.includes('--yes')) throw new Error('请使用 --yes 确认删除'); return action === 'forget' ? core.forgetMemory(ownerId, memoryId) : core.eraseMemory(ownerId, memoryId); }
    if (group === 'memory' && action === 'clear') { if (!argv.includes('--yes')) throw new Error('请使用 --yes 确认删除'); return { ...await core.clearMemories(ownerId), boundary: CLEAR_BOUNDARY }; }
    if (group === 'memory' && action === 'pause') return core.pauseMemory(ownerId);
    if (group === 'memory' && action === 'resume') return core.resumeMemory(ownerId);
    if (group === 'proactive' && action === 'status') return ownerId ? core.ownerStatus(ownerId) : core.status();
    if (group === 'proactive' && action === 'pause') return core.pause(ownerId, 'cli');
    if (group === 'proactive' && action === 'resume') return core.resume(ownerId);
    throw new Error('不支持的 companion CLI 命令');
  } finally { if (!service) await core.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli().then((result) => console.log(JSON.stringify(result ?? null, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
