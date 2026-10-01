import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const EMOTIONS = ['happy', 'sad', 'angry_playful', 'comfort', 'surprised', 'teasing'];
const CONTEXTS = ['reply', 'follow-up', 'morning', 'evening'];
const FOLDERS = {
  happy: '开心',
  sad: '难过',
  angry_playful: '假装生气',
  comfort: '安慰',
  surprised: '惊讶',
  teasing: '调侃',
};
const ALIASES = new Map([
  ['happy', 'happy'], ['开心', 'happy'], ['高兴', 'happy'], ['快乐', 'happy'],
  ['sad', 'sad'], ['难过', 'sad'], ['伤心', 'sad'], ['委屈', 'sad'],
  ['angry_playful', 'angry_playful'], ['假装生气', 'angry_playful'], ['生气', 'angry_playful'], ['傲娇', 'angry_playful'],
  ['comfort', 'comfort'], ['安慰', 'comfort'], ['抱抱', 'comfort'], ['关心', 'comfort'],
  ['surprised', 'surprised'], ['惊讶', 'surprised'], ['震惊', 'surprised'], ['吃惊', 'surprised'],
  ['teasing', 'teasing'], ['调侃', 'teasing'], ['逗你', 'teasing'], ['坏笑', 'teasing'], ['搞怪', 'teasing'],
]);
const SEMANTIC_GROUPS = {
  greeting_morning: ['早安', '早上好', '起床', '早呀'],
  greeting_evening: ['晚安', '睡觉', '早点睡', '困了'],
  joy: ['开心', '高兴', '快乐', '哈哈', '笑死', '好耶', '真棒', '厉害', '鼓掌'],
  affection: ['喜欢', '爱你', '可爱', '亲亲', '抱抱', '贴贴'],
  reassurance: ['摸摸', '安慰', '没事', '别怕', '陪你', '乖', '心疼'],
  encouragement: ['加油', '辛苦', '可以的', '别放弃'],
  sorrow: ['难过', '伤心', '委屈', '想哭', '哭了', '心碎', '不开心', '可怜'],
  exhausted: ['好累', '累死', '疲惫', '想躺', '想静静'],
  surprised: ['震惊', '惊讶', '居然', '卧槽', '什么鬼', '问号', '真的假的', '不敢相信', '啊这'],
  teasing: ['无语', '呵呵', '吃瓜', '看戏', '搞笑', '就这', '离谱'],
  work: ['摸鱼', '上班', '下班', '加班', '工作', '打工'],
  money: ['赚钱', '搞钱', '有钱', '没钱', '富婆', '发财'],
  romance: ['单身', '对象', '恋爱', '约会', '脱单'],
  angry_playful: ['生气', '哼', '不理你', '打你', '气死', '讨厌', '哄不好', '闭嘴', '傲娇'],
};

export function defaultStickerRoot({ dshHome } = {}) {
  return resolve(dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'integrations', 'dsh-companion', 'stickers');
}

async function readManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.version !== 1 || !Array.isArray(manifest.stickers)) throw new TypeError('invalid sticker manifest');
  return manifest;
}

function validateSticker(sticker, ids) {
  if (!sticker || typeof sticker.id !== 'string' || ids.has(sticker.id)
    || typeof sticker.file !== 'string' || sticker.file.startsWith('/') || sticker.file.includes('..')
    || !TYPES[extname(sticker.file).toLowerCase()] || ![1, 2, 3].includes(Number(sticker.intensity))
    || !EMOTIONS.includes(sticker.emotion) || !Array.isArray(sticker.tags ?? [])
    || (sticker.caption !== undefined && (typeof sticker.caption !== 'string' || sticker.caption.length > 240))
    || !Array.isArray(sticker.keywords ?? []) || (sticker.keywords ?? []).some((item) => typeof item !== 'string' || !item.trim() || item.length > 40)
    || !Array.isArray(sticker.contexts ?? []) || sticker.contexts.some((item) => !CONTEXTS.includes(item))) {
    throw new TypeError('invalid sticker manifest item');
  }
  ids.add(sticker.id);
}

function normalizedText(value) {
  return String(value ?? '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function semanticFeatures(value) {
  const text = normalizedText(value);
  const features = new Set(text.split(/\s+/).filter(Boolean));
  const compact = text.replace(/\s+/g, '');
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index + size <= compact.length; index += 1) features.add(compact.slice(index, index + size));
  }
  for (const [concept, phrases] of Object.entries(SEMANTIC_GROUPS)) {
    if (phrases.some((phrase) => compact.includes(phrase))) features.add(`concept:${concept}`);
  }
  return features;
}

export function inferStickerIntent(value, { context = 'reply' } = {}) {
  const text = String(value ?? '').trim();
  const compact = normalizedText(text).replace(/\s+/g, '');
  const scores = new Map(EMOTIONS.map((emotion) => [emotion, 0]));
  const add = (emotion, phrases, weight = 1) => {
    for (const phrase of phrases) if (compact.includes(phrase)) scores.set(emotion, scores.get(emotion) + weight);
  };
  add('happy', [...SEMANTIC_GROUPS.joy, ...SEMANTIC_GROUPS.greeting_morning, ...SEMANTIC_GROUPS.greeting_evening], 2);
  add('comfort', [...SEMANTIC_GROUPS.reassurance, ...SEMANTIC_GROUPS.encouragement, ...SEMANTIC_GROUPS.exhausted], 2);
  add('sad', SEMANTIC_GROUPS.sorrow, 2);
  add('surprised', SEMANTIC_GROUPS.surprised, 2);
  add('angry_playful', SEMANTIC_GROUPS.angry_playful, 2);
  add('teasing', [...SEMANTIC_GROUPS.teasing, ...SEMANTIC_GROUPS.money, ...SEMANTIC_GROUPS.romance, ...SEMANTIC_GROUPS.work], 1);
  let emotion = 'teasing';
  let best = 0;
  for (const [candidate, score] of scores) {
    if (score > best) { emotion = candidate; best = score; }
  }
  return { emotion, intensity: 1, context, query: text.slice(0, 600) };
}

export function semanticStickerScore(query, sticker, intent = {}) {
  const queryFeatures = semanticFeatures(query);
  const documentText = [sticker.caption, ...(sticker.keywords ?? []), ...(sticker.tags ?? []), basename(sticker.file, extname(sticker.file))].filter(Boolean).join(' ');
  const documentFeatures = semanticFeatures(documentText);
  let score = intent.emotion === sticker.emotion ? 2.5 : 0;
  for (const feature of queryFeatures) {
    if (!documentFeatures.has(feature)) continue;
    score += feature.startsWith('concept:') ? 6 : feature.length >= 3 ? 2 : 1;
  }
  for (const keyword of sticker.keywords ?? []) {
    if (normalizedText(query).includes(normalizedText(keyword))) score += 6;
  }
  return score;
}

export async function initializeStickerDirectory({ rootDir = defaultStickerRoot(), manifestPath = join(rootDir, 'stickers.json') } = {}) {
  const root = resolve(rootDir);
  await mkdir(join(root, 'assets'), { recursive: true });
  await Promise.all(Object.values(FOLDERS).map((folder) => mkdir(join(root, 'inbox', folder), { recursive: true })));
  await mkdir(dirname(resolve(manifestPath)), { recursive: true });
  try {
    await writeFile(resolve(manifestPath), `${JSON.stringify({ version: 1, stickers: [] }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await readManifest(resolve(manifestPath));
  }
  return { rootDir: root, manifestPath: resolve(manifestPath), inboxDir: join(root, 'inbox') };
}

async function collectFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, output);
    else if (entry.isFile() && TYPES[extname(entry.name).toLowerCase()]) output.push(path);
  }
  return output;
}

function emotionFor(sourceRoot, file) {
  const parts = relative(sourceRoot, file).split(/[\\/]/);
  for (const rawPart of parts) {
    const part = basename(rawPart, extname(rawPart)).trim().toLowerCase();
    if (ALIASES.has(part)) return ALIASES.get(part);
    for (const [alias, emotion] of ALIASES) {
      if (part.startsWith(`${alias}-`) || part.startsWith(`${alias}_`)) return emotion;
    }
  }
  return null;
}

export async function importStickerDirectory({ sourceDir, rootDir = defaultStickerRoot(), manifestPath = join(rootDir, 'stickers.json') } = {}) {
  if (typeof sourceDir !== 'string' || !sourceDir.trim()) throw new TypeError('sticker source directory is required');
  const initialized = await initializeStickerDirectory({ rootDir, manifestPath });
  const sourceRoot = await realpath(resolve(sourceDir));
  const manifest = await readManifest(initialized.manifestPath);
  const existingIds = new Set(manifest.stickers.map((item) => item.id));
  const skipped = [];
  let imported = 0;
  let duplicates = 0;

  for (const sourceFile of await collectFiles(sourceRoot)) {
    const emotion = emotionFor(sourceRoot, sourceFile);
    if (!emotion) { skipped.push(relative(sourceRoot, sourceFile)); continue; }
    const bytes = await readFile(sourceFile);
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) { skipped.push(relative(sourceRoot, sourceFile)); continue; }
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const id = `${emotion}-${hash}`;
    const extension = extname(sourceFile).toLowerCase();
    const relativeFile = `assets/${emotion}/${hash}${extension}`;
    const destination = join(initialized.rootDir, ...relativeFile.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourceFile, destination);
    if (existingIds.has(id)) { duplicates += 1; continue; }
    manifest.stickers.push({ id, file: relativeFile, emotion, intensity: 1, tags: [], contexts: [] });
    existingIds.add(id);
    imported += 1;
  }

  manifest.stickers.sort((left, right) => left.id.localeCompare(right.id));
  await writeFile(initialized.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { ...initialized, imported, duplicates, skippedCount: skipped.length, skipped };
}

export async function createStickerCatalog({ rootDir, manifestPath, now = () => new Date().toISOString(), cooldownMs = 86_400_000, random = Math.random } = {}) {
  const root = resolve(rootDir);
  const realRoot = await realpath(root);
  const manifest = await readManifest(manifestPath);
  const ids = new Set();
  for (const sticker of manifest.stickers) validateSticker(sticker, ids);
  const stickers = manifest.stickers;
  let writeQueue = Promise.resolve();
  const enqueueWrite = (task) => {
    const next = writeQueue.then(task, task);
    writeQueue = next.catch(() => undefined);
    return next;
  };
  const detectImage = (bytes) => {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['.png', 'image/png'];
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['.jpg', 'image/jpeg'];
    const head = bytes.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return ['.gif', 'image/gif'];
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return ['.webp', 'image/webp'];
    return null;
  };
  const persistManifest = async () => {
    const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, stickers }, null, 2)}\n`, 'utf8');
    await rename(temporary, manifestPath);
  };
  return {
    get size() { return stickers.length; },
    async addBuffer(input, metadata = {}) {
      return enqueueWrite(async () => {
        const bytes = Buffer.from(input ?? []);
        if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('sticker-oversize');
        const detected = detectImage(bytes);
        if (!detected) throw new Error('sticker-format');
        const hash = createHash('sha256').update(bytes).digest('hex');
        const existing = stickers.find((item) => item.source?.contentHash === hash || item.id === `personal-${hash}`);
        if (existing) return { sticker: existing, duplicate: true };
        const [extension] = detected;
        const relativeFile = `assets/personal/${hash}${extension}`;
        const destination = resolve(root, relativeFile);
        await mkdir(dirname(destination), { recursive: true });
        const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, bytes);
        await rename(temporary, destination);
        const emotion = EMOTIONS.includes(metadata.emotion) ? metadata.emotion : 'teasing';
        const sticker = {
          id: `personal-${hash}`,
          file: relativeFile,
          emotion,
          intensity: [1, 2, 3].includes(Number(metadata.intensity)) ? Number(metadata.intensity) : 1,
          caption: typeof metadata.caption === 'string' ? metadata.caption.slice(0, 240) : '',
          keywords: Array.isArray(metadata.keywords) ? metadata.keywords.filter((item) => typeof item === 'string').slice(0, 6) : [],
          tags: [], contexts: [],
          source: {
            type: 'personal-chat',
            channel: metadata.channel ?? null,
            messageId: metadata.messageId ?? null,
            collectedAt: metadata.collectedAt ?? now(),
            contentHash: hash,
          },
        };
        stickers.push(sticker);
        try { await persistManifest(); } catch (error) {
          stickers.pop();
          await import('node:fs/promises').then(({ unlink }) => unlink(destination).catch(() => undefined));
          throw error;
        }
        return { sticker, duplicate: false };
      });
    },
    async importBuffer(input, metadata = {}) { return this.addBuffer(input, metadata); },
    select(intent, { capabilities = {}, recentUsage = new Map() } = {}) {
      if (!capabilities.image && !capabilities.sticker) return null;
      let candidates = stickers.filter((sticker) => Number(sticker.intensity) <= Number(intent?.intensity ?? 0)
        && (!sticker.contexts.length || sticker.contexts.includes(intent.context))
        && (!sticker.tags.length || !intent.tag || sticker.tags.includes(intent.tag)))
        .filter((sticker) => Date.parse(now()) - Date.parse(recentUsage.get(sticker.id) ?? '1970-01-01') >= cooldownMs);
      if (!candidates.length) return null;
      const query = typeof intent?.query === 'string' ? intent.query.trim() : '';
      if (query) {
        const ranked = candidates.map((sticker) => ({ sticker, score: semanticStickerScore(query, sticker, intent) }))
          .sort((left, right) => right.score - left.score);
        const best = ranked[0]?.score ?? 0;
        candidates = best >= 4
          ? ranked.filter((item) => item.score >= best * 0.88).map((item) => item.sticker)
          : candidates.filter((sticker) => sticker.emotion === intent?.emotion);
      } else {
        candidates = candidates.filter((sticker) => sticker.emotion === intent?.emotion);
      }
      if (!candidates.length) return null;
      return candidates[Math.min(candidates.length - 1, Math.floor(Math.max(0, Number(random()) || 0) * candidates.length))];
    },
    async materialize(id) {
      const sticker = stickers.find((item) => item.id === id);
      if (!sticker) throw new Error('sticker-not-found');
      const file = resolve(realRoot, sticker.file);
      const real = await realpath(file);
      if (relative(realRoot, real).startsWith('..')) throw new Error('sticker-traversal');
      const extension = extname(real).toLowerCase();
      if (!TYPES[extension]) throw new Error('sticker-type');
      const bytes = await readFile(real);
      if (bytes.length > 10 * 1024 * 1024) throw new Error('sticker-oversize');
      return { bytes, fileName: sticker.id + extension, mediaType: TYPES[extension] };
    },
  };
}
