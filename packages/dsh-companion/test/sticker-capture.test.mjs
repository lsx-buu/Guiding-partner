import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStickerCatalog, initializeStickerDirectory } from '../src/sticker.mjs';
import { createStickerCapture } from '../src/sticker-capture.mjs';
import { fallbackStickerAnnotation, parseStickerAnnotation } from '../src/sticker-annotator.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test('sticker capture starts, imports images, ignores text, and ends per route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sticker-'));
  const manifestPath = join(root, 'stickers.json');
  await initializeStickerDirectory({ rootDir: root, manifestPath });
  const catalog = await createStickerCatalog({ rootDir: root, manifestPath });
  const capture = createStickerCapture({ stickerCatalog: catalog, annotator: { annotate: async () => ({ emotion: 'happy', caption: '好耶', keywords: ['开心'] }) } });
  const event = { routeId: 'r', ownerId: 'o', channel: 'weixin', messageId: 'm', normalizedText: '/bqb', images: [] };
  assert.equal((await capture.handle(event)).replies[0].includes('发来'), true);
  assert.equal((await capture.handle({ ...event, normalizedText: '文字', images: [] })).replies[0].includes('继续发图'), true);
  const image = { load: async () => PNG, mediaType: 'image/png' };
  assert.equal((await capture.handle({ ...event, normalizedText: '', images: [image] })).replies[0], '收下了，第 1 张。');
  assert.equal((await capture.handle({ ...event, normalizedText: '', images: [image] })).replies[0], '这张已经有啦，目前收了 1 张。');
  assert.equal(catalog.size, 1);
  assert.equal((await capture.handle({ ...event, normalizedText: '/bqb_end' })).replies[0], '收好了，这次新增 1 张，重复 1 张。');
  assert.equal((await capture.handle({ ...event, normalizedText: '/bqb_end' })).replies[0].includes('还没开始'), true);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).stickers.length, 1);
});

test('catalog addBuffer dynamically selects/materializes, deduplicates, and rejects formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-'));
  const manifestPath = join(root, 'stickers.json');
  await initializeStickerDirectory({ rootDir: root, manifestPath });
  const catalog = await createStickerCatalog({ rootDir: root, manifestPath, random: () => 0 });
  const first = await catalog.addBuffer(PNG, { emotion: 'happy', caption: '好耶', keywords: ['开心'] });
  const duplicate = await catalog.addBuffer(PNG, { emotion: 'happy' });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(catalog.size, 1);
  assert.equal(catalog.select({ emotion: 'happy', intensity: 1, query: '好耶' }, { capabilities: { image: true } }).id, first.sticker.id);
  assert.deepEqual((await catalog.materialize(first.sticker.id)).bytes, PNG);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).stickers.length, 1);
  await assert.rejects(() => catalog.addBuffer(Buffer.from('not-an-image')), /sticker-format/);
});

test('capture serializes image and end events on one route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-serial-'));
  const manifestPath = join(root, 'stickers.json');
  await initializeStickerDirectory({ rootDir: root, manifestPath });
  const catalog = await createStickerCatalog({ rootDir: root, manifestPath });
  let calls = 0;
  const capture = createStickerCapture({ stickerCatalog: catalog, annotator: { annotate: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { emotion: 'happy' }; } } });
  const base = { routeId: 'serial', ownerId: 'owner', channel: 'qq', images: [{ load: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); calls += 1; return Buffer.from([...PNG, calls]); } }] };
  await capture.handle({ ...base, normalizedText: '/bqb' });
  const first = capture.handle({ ...base, messageId: '1', normalizedText: '' });
  const second = capture.handle({ ...base, messageId: '2', normalizedText: '' });
  const ending = capture.handle({ ...base, normalizedText: '/bqb_end', images: [] });
  const [one, two, end] = await Promise.all([first, second, ending]);
  assert.equal(one.replies[0], '收下了，第 1 张。');
  assert.equal(two.replies[0], '收下了，第 2 张。');
  assert.equal(end.replies[0], '收好了，这次新增 2 张。');
});

test('sticker annotation parser is strict and fallback is safe', () => {
  assert.deepEqual(parseStickerAnnotation('{"emotion":"angry_playful","caption":"哼","keywords":["气"]}'), { emotion: 'angry_playful', caption: '哼', keywords: ['气'] });
  assert.deepEqual(fallbackStickerAnnotation().emotion, 'teasing');
  assert.throws(() => parseStickerAnnotation('not json'));
  assert.throws(() => parseStickerAnnotation('{"emotion":"unknown","caption":"嗯","keywords":[]}'));
  assert.throws(() => parseStickerAnnotation('{"emotion":"happy","caption":"嗯","keywords":[],"extra":true}'));
});

test('Harness sticker annotator creates a session and asks with DSH multimodal content', async () => {
  const calls = [];
  const { createHarnessStickerAnnotator } = await import('../src/sticker-annotator.mjs');
  const annotator = createHarnessStickerAnnotator({ harness: {
    async createSession(options) { calls.push(['session', options]); return 's1'; },
    async ask(session, content) { calls.push(['ask', session, content]); return '{"emotion":"surprised","caption":"啊这","keywords":["震惊"]}'; },
  } });
  const result = await annotator.annotate({ bytes: PNG });
  assert.equal(result.emotion, 'surprised');
  assert.equal(calls[0][1].purpose, 'companion-sticker-annotation');
  assert.equal(calls[1][1], 's1');
  assert.deepEqual(calls[1][2].map((item) => item.type), ['text', 'image']);
  assert.equal(calls[1][2][1].mediaType, 'image/png');
});
