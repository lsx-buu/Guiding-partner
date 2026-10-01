import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteTopicQuery, createHarnessTopicProvider, rankTopicResults } from '../src/topic.mjs';
import { createStickerCatalog, importStickerDirectory, initializeStickerDirectory, semanticStickerScore } from '../src/sticker.mjs';
import { collectChineseBqb } from '../src/sticker-collector.mjs';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('topic PII is discarded before provider use', () => { assert.equal(rewriteTopicQuery([{ kind: 'interest', sensitivity: 'normal', summary: '住在上海喜欢咖啡' }]), null); });
test('topic provider requires strict https results and web search prompt', async () => { let prompt = ''; const provider = createHarnessTopicProvider({ harness: { createSession: async () => ({}), ask: async (_, p) => { prompt = p; return JSON.stringify({ results: [{ title: 'Coffee', url: 'https://example.test/a', snippet: 'x' }] }); } } }); const results = await provider.search('coffee'); assert.equal(results.length, 1); assert.match(prompt, /web_search/); });
test('topic ranking removes duplicate urls and weak results', () => { const result = rankTopicResults([{ title: 'x', url: 'https://x.test', snippet: 'a' }, { title: 'x2', url: 'https://x.test', snippet: 'b' }], 'x'); assert.equal(result.url, 'https://x.test'); assert.equal(rankTopicResults([{ title: 'z', url: 'https://z.test', snippet: 'a' }], 'different'), null); });
test('sticker catalog rejects traversal and unsupported files', async (t) => { const dir = await mkdtemp(join(tmpdir(), 'sticker-test-')); t.after(() => rm(dir, { recursive: true, force: true })); const path = join(dir, 'manifest.json'); await writeFile(path, JSON.stringify({ version: 1, stickers: [{ id: 'bad', file: '../x.exe', emotion: 'happy', intensity: 1, tags: [], contexts: [] }] })); await assert.rejects(() => createStickerCatalog({ rootDir: dir, manifestPath: path }), /invalid sticker manifest/); });
test('sticker catalog materializes png and respects capability/cooldown', async (t) => { const dir = await mkdtemp(join(tmpdir(), 'sticker-test-')); t.after(() => rm(dir, { recursive: true, force: true })); await mkdir(join(dir, 'assets')); await writeFile(join(dir, 'assets', 'a.png'), Buffer.from([137,80,78,71])); const path = join(dir, 'manifest.json'); await writeFile(path, JSON.stringify({ version: 1, stickers: [{ id: 'a', file: 'assets/a.png', emotion: 'happy', intensity: 1, tags: [], contexts: [] }] })); const catalog = await createStickerCatalog({ rootDir: dir, manifestPath: path, cooldownMs: 100000 }); const selected = catalog.select({ emotion: 'happy', intensity: 1, context: 'morning' }, { capabilities: { image: true } }); assert.ok(selected); assert.equal((await catalog.materialize('a')).mediaType, 'image/png'); assert.equal(catalog.select({ emotion: 'happy', intensity: 1, context: 'morning' }, { capabilities: { image: false } }), null); });
test('sticker importer understands Chinese folders and skips unclassified images', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-import-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'); const root = join(dir, 'catalog');
  await mkdir(join(source, '开心'), { recursive: true }); await mkdir(join(source, '未分类'), { recursive: true });
  await writeFile(join(source, '开心', 'a.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(source, '未分类', 'b.gif'), Buffer.from('GIF89a'));
  const result = await importStickerDirectory({ sourceDir: source, rootDir: root });
  assert.equal(result.imported, 1); assert.equal(result.skippedCount, 1);
  const catalog = await createStickerCatalog({ rootDir: root, manifestPath: join(root, 'stickers.json') });
  assert.equal(catalog.size, 1); assert.equal(catalog.select({ emotion: 'happy', intensity: 1 }, { capabilities: { image: true } }).emotion, 'happy');
  assert.equal((await importStickerDirectory({ sourceDir: source, rootDir: root })).duplicates, 1);
});
test('sticker init creates an empty usable catalog and selection is randomized', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-init-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await initializeStickerDirectory({ rootDir: dir });
  assert.equal((await createStickerCatalog({ rootDir: dir, manifestPath: join(dir, 'stickers.json') })).size, 0);
  await mkdir(join(dir, 'assets', 'happy'), { recursive: true });
  await writeFile(join(dir, 'assets', 'happy', 'a.png'), Buffer.from([1])); await writeFile(join(dir, 'assets', 'happy', 'b.png'), Buffer.from([2]));
  await writeFile(join(dir, 'stickers.json'), JSON.stringify({ version: 1, stickers: [
    { id: 'a', file: 'assets/happy/a.png', emotion: 'happy', intensity: 1, tags: [], contexts: [] },
    { id: 'b', file: 'assets/happy/b.png', emotion: 'happy', intensity: 1, tags: [], contexts: [] },
  ] }));
  const catalog = await createStickerCatalog({ rootDir: dir, manifestPath: join(dir, 'stickers.json'), random: () => 0.9 });
  assert.equal(catalog.select({ emotion: 'happy', intensity: 1 }, { capabilities: { image: true } }).id, 'b');
});
test('semantic sticker search ranks conversational meaning above a coarse emotion bucket', () => {
  const work = { emotion: 'teasing', caption: '今天不想上班，只想摸鱼', keywords: ['上班', '摸鱼'], tags: [], file: 'assets/work.png' };
  const generic = { emotion: 'happy', caption: '开心鼓掌', keywords: ['开心'], tags: [], file: 'assets/happy.png' };
  assert.ok(semanticStickerScore('上班好累，还是摸鱼吧', work, { emotion: 'happy' }) > semanticStickerScore('上班好累，还是摸鱼吧', generic, { emotion: 'happy' }));
});
test('ChineseBQB collector saves attributed searchable metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-collect-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = [
    { name: '猫猫001-早安开心.gif', category: '猫猫', url: 'https://raw.test/happy.gif' },
    { name: '猫猫002-抱抱晚安.jpg', category: '猫猫', url: 'https://raw.test/comfort.jpg' },
  ];
  const fetch = async (url) => url.includes('chinesebqb_github.json')
    ? { ok: true, json: async () => ({ data: entries }) }
    : { ok: true, headers: new Headers({ 'content-length': '6' }), arrayBuffer: async () => Buffer.from(url.endsWith('.gif') ? 'GIF89a' : [255, 216, 255, 217]) };
  const result = await collectChineseBqb({ rootDir: dir, limit: 6, fetch, wait: async () => {} });
  assert.equal(result.collected, 2); assert.equal(result.failed, 0);
  const manifest = JSON.parse(await readFile(join(dir, 'stickers.json'), 'utf8'));
  assert.equal(manifest.stickers.length, 2); assert.equal(manifest.stickers.every((item) => item.caption && item.source?.dataset === 'ChineseBQB'), true);
});

test('ChineseBQB collector resumes existing files and reports final/new totals', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-collect-resume-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = [
    { name: '猫猫001-早安开心.gif', category: '猫猫', url: 'https://raw.test/resume.gif' },
    { name: '猫猫002-抱抱晚安.jpg', category: '猫猫', url: 'https://raw.test/resume.jpg' },
  ];
  let imageCalls = 0;
  const fetch = async (url) => url.includes('chinesebqb_github.json')
    ? { ok: true, json: async () => ({ data: entries }) }
    : { ok: true, headers: new Headers({ 'content-length': '6' }), arrayBuffer: async () => { imageCalls += 1; return Buffer.from(url.endsWith('.gif') ? 'GIF89a' : [255, 216, 255, 217]); } };
  const first = await collectChineseBqb({ rootDir: dir, limit: 2, fetch, wait: async () => {} });
  const callsAfterFirst = imageCalls;
  const second = await collectChineseBqb({ rootDir: dir, limit: 2, fetch, wait: async () => {} });
  assert.equal(first.total, 2); assert.equal(first.added, 2); assert.equal(first.reused, 0);
  assert.equal(second.total, 2); assert.equal(second.added, 0); assert.equal(second.reused, 2);
  assert.equal(imageCalls, callsAfterFirst);
});

test('ChineseBQB collector trims an existing catalog to the requested target', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-collect-cap-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = [
    { name: '猫猫001-早安开心.gif', category: '猫猫', url: 'https://raw.test/cap-a.gif' },
    { name: '猫猫002-开心大笑.gif', category: '猫猫', url: 'https://raw.test/cap-b.gif' },
    { name: '猫猫003-抱抱晚安.jpg', category: '猫猫', url: 'https://raw.test/cap-c.jpg' },
  ];
  const fetch = async (url) => url.includes('chinesebqb_github.json')
    ? { ok: true, json: async () => ({ data: entries }) }
    : { ok: true, headers: new Headers({ 'content-length': '8' }), arrayBuffer: async () => Buffer.concat([Buffer.from(url.endsWith('.gif') ? 'GIF89a' : [255, 216, 255]), Buffer.from(url)]) };
  const first = await collectChineseBqb({ rootDir: dir, limit: 3, fetch, wait: async () => {} });
  const second = await collectChineseBqb({ rootDir: dir, limit: 2, fetch, wait: async () => {} });
  assert.equal(first.total, 3);
  assert.equal(second.total, 2);
  assert.equal(JSON.parse(await readFile(join(dir, 'stickers.json'), 'utf8')).stickers.length, 2);
});

test('ChineseBQB collector retries transient image failures and continues after permanent failures', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-collect-retry-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = [
    { name: '猫猫001-早安开心.gif', category: '猫猫', url: 'https://raw.test/retry.gif' },
    { name: '猫猫002-抱抱晚安.jpg', category: '猫猫', url: 'https://raw.test/fail.jpg' },
  ];
  const attempts = new Map();
  const fetch = async (url) => url.includes('chinesebqb_github.json')
    ? { ok: true, json: async () => ({ data: entries }) }
    : (() => {
      const count = (attempts.get(url) ?? 0) + 1; attempts.set(url, count);
      if (url.endsWith('fail.jpg')) throw new Error('offline');
      if (count < 3) throw new Error('transient');
      return { ok: true, headers: new Headers({ 'content-length': '6' }), arrayBuffer: async () => Buffer.from('GIF89a') };
    })();
  const result = await collectChineseBqb({ rootDir: dir, limit: 2, fetch, wait: async () => {} });
  assert.equal(result.total, 1); assert.equal(result.added, 1); assert.equal(result.failed, 1);
  assert.equal(attempts.get('https://raw.test/retry.gif'), 3);
  assert.equal(attempts.get('https://raw.test/fail.jpg'), 3);
});
