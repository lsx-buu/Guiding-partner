import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { defaultStickerRoot, initializeStickerDirectory } from './sticker.mjs';

const INDEX_URL = 'https://raw.githubusercontent.com/zhaoolee/ChineseBQB/master/chinesebqb_github.json';
const SOURCE_PAGE = 'https://github.com/zhaoolee/ChineseBQB';
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const BLOCKED_TEXT = /(?:傻逼|煞笔|妈的|你妈|妈逼|妈比|妈批|妈卖批|麻痹|尼玛|操你|草你|去死|死全家|强奸|色情|裸照|纳粹|种族|港独|台独|单身狗|老子|给我滚|废物|婊|贱人|打死)/i;
const TARGETS = [
  { emotion: 'happy', keywords: ['开心', '高兴', '哈哈', '笑', '好耶', '喜欢', '爱你', '亲亲', '可爱', '真棒', '鼓掌', '早安', '早上好', '耶', '赞', '么么', '快乐', '幸福'] },
  { emotion: 'comfort', keywords: ['抱抱', '摸摸', '安慰', '没事', '加油', '辛苦', '乖', '陪你', '别怕', '晚安', '睡觉', '早点睡', '关心', '心疼', '休息', '保重', '暖', '好梦'] },
  { emotion: 'sad', keywords: ['难过', '伤心', '委屈', '哭', '心碎', '可怜', '累', '不开心', '想静静', '悲伤', '失落', '孤独', '泪', '惨', '心痛'] },
  { emotion: 'surprised', keywords: ['震惊', '惊讶', '居然', '卧槽', '什么鬼', '问号', '不敢相信', '真的吗', '啊这', '啥', '懵', '吓', '看傻', '不可思议', '真的假的', '诶'] },
  { emotion: 'teasing', keywords: ['无语', '呵呵', '吃瓜', '看戏', '搞笑', '笑死', '就这', '离谱', '摸鱼', '赚钱', '有钱', '富婆', '单身', '对象', '上班', '下班', '调皮', '坏笑', '尴尬', '沙雕', '逗', '嫌弃'] },
  { emotion: 'angry_playful', keywords: ['生气', '愤怒', '哼', '不理你', '打你', '气死', '讨厌', '哄不好', '闭嘴', '怒', '烦', '凶', '揍', '不爽', '不服', '咬', '火大', '暴躁'] },
];

function cleanCaption(entry) {
  const extension = extname(entry.name);
  let caption = entry.name.slice(0, extension ? -extension.length : undefined)
    .replace(/^[A-Za-z_\d]+/, '').replace(/^[-_\s]+/, '').trim();
  const separator = caption.indexOf('-');
  if (separator >= 0 && /\d/.test(caption.slice(0, separator))) caption = caption.slice(separator + 1);
  return caption.replace(/[-_]+/g, ' ').trim() || entry.category;
}

function stableOrder(value) {
  return createHash('sha256').update(value).digest().readUInt32BE(0);
}

function candidatesFor(data, target) {
  return data.map((entry) => {
    const searchable = `${entry.name} ${entry.category}`;
    const matches = target.keywords.filter((keyword) => searchable.includes(keyword));
    return { entry, matches, caption: cleanCaption(entry) };
  }).filter(({ entry, matches, caption }) => matches.length > 0
    && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())
    && !BLOCKED_TEXT.test(`${entry.name} ${entry.category}`)
    && /[\u3400-\u9fff]/u.test(caption))
    .sort((left, right) => right.matches.length - left.matches.length
      || stableOrder(left.entry.url) - stableOrder(right.entry.url));
}

function safeCandidates(data) {
  return data.map((entry) => ({ entry, matches: [], caption: cleanCaption(entry) }))
    .filter(({ entry, caption }) => SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())
      && !BLOCKED_TEXT.test(`${entry.name} ${entry.category}`)
      && /[\u3400-\u9fff]/u.test(caption))
    .sort((left, right) => stableOrder(left.entry.url) - stableOrder(right.entry.url));
}

async function fetchJson(fetchImpl, url, wait) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': 'dsh-companion-sticker-collector/0.1' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`sticker index request failed: ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function fetchImage(fetchImpl, url, wait) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': 'dsh-companion-sticker-collector/0.1' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`sticker image request failed: ${response.status}`);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > 10 * 1024 * 1024) throw new Error('sticker image is too large');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error('sticker image is empty or too large');
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

function detectedExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return '.gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return '.webp';
  return null;
}

async function validStickerFile(rootDir, relativeFile) {
  if (typeof relativeFile !== 'string' || relativeFile.startsWith('/') || relativeFile.includes('..')) return false;
  try {
    const bytes = await readFile(resolve(rootDir, ...relativeFile.split('/')));
    const detected = detectedExtension(bytes);
    const declared = extname(relativeFile).toLowerCase();
    return detected === declared || (detected === '.jpg' && declared === '.jpeg');
  } catch { return false; }
}

export async function collectChineseBqb({
  rootDir = defaultStickerRoot(),
  manifestPath = join(rootDir, 'stickers.json'),
  limit = 72,
  fetch: fetchImpl = globalThis.fetch,
  wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 300) throw new TypeError('sticker collection limit must be between 1 and 300');
  const initialized = await initializeStickerDirectory({ rootDir, manifestPath });
  const indexCachePath = join(initialized.rootDir, 'ChineseBQB-index.json');
  let payload;
  try {
    payload = await fetchJson(fetchImpl, INDEX_URL, wait);
    await writeFile(indexCachePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) {
    try { payload = JSON.parse(await readFile(indexCachePath, 'utf8')); } catch { throw error; }
  }
  if (!Array.isArray(payload?.data)) throw new TypeError('invalid ChineseBQB index');
  const manifest = JSON.parse(await readFile(initialized.manifestPath, 'utf8'));
  const retainedChinese = [];
  for (const item of manifest.stickers) {
    if (item.source?.dataset !== 'ChineseBQB') continue;
    if (!BLOCKED_TEXT.test(`${item.caption ?? ''} ${item.source?.url ?? ''}`)
      && await validStickerFile(initialized.rootDir, item.file)) retainedChinese.push(item);
  }
  manifest.stickers = manifest.stickers.filter((item) => item.source?.dataset !== 'ChineseBQB');
  manifest.stickers.push(...retainedChinese);
  const existingIds = new Set(manifest.stickers.map((item) => item.id));
  const selectedUrls = new Set(retainedChinese.map((item) => item.source?.url).filter(Boolean));
  const existingCounts = new Map(TARGETS.map(({ emotion }) => [emotion, 0]));
  for (const item of retainedChinese) existingCounts.set(item.emotion, (existingCounts.get(item.emotion) ?? 0) + 1);
  const base = Math.floor(limit / TARGETS.length);
  const remainder = limit % TARGETS.length;
  const quotas = new Map(TARGETS.map(({ emotion }, index) => [emotion, base + (index < remainder ? 1 : 0)]));
  const queue = [];
  const fallback = safeCandidates(payload.data);
  for (const target of TARGETS) {
    const candidates = candidatesFor(payload.data, target);
    const targetQueue = [];
    const needed = Math.max(0, (quotas.get(target.emotion) ?? 0) - (existingCounts.get(target.emotion) ?? 0));
    for (const keyword of target.keywords) {
      const candidate = candidates.find((item) => item.matches.includes(keyword) && !selectedUrls.has(item.entry.url));
      if (!candidate) continue;
      selectedUrls.add(candidate.entry.url);
      targetQueue.push({ ...candidate, emotion: target.emotion });
      if (targetQueue.length >= needed) break;
    }
    for (const candidate of candidates) {
      if (targetQueue.length >= needed) break;
      if (selectedUrls.has(candidate.entry.url)) continue;
      selectedUrls.add(candidate.entry.url);
      targetQueue.push({ ...candidate, emotion: target.emotion });
    }
    for (const candidate of fallback) {
      if (targetQueue.length >= needed) break;
      if (selectedUrls.has(candidate.entry.url)) continue;
      selectedUrls.add(candidate.entry.url);
      targetQueue.push({ ...candidate, emotion: target.emotion });
    }
    queue.push(...targetQueue);
  }

  // If one emotion's keyword bucket is unusually sparse, use remaining safe entries
  // to fill the global target while keeping the first-pass quotas balanced.
  const remaining = Math.max(0, limit - retainedChinese.length - queue.length);
  if (remaining) {
    const deficits = TARGETS.flatMap((target) => Array(Math.max(0,
      (quotas.get(target.emotion) ?? 0) - (existingCounts.get(target.emotion) ?? 0)
      - queue.filter((item) => item.emotion === target.emotion).length)).fill(target.emotion));
    for (const candidate of fallback) {
      if (queue.length >= limit - retainedChinese.length || selectedUrls.has(candidate.entry.url)) continue;
      const emotion = deficits.shift() ?? TARGETS[queue.length % TARGETS.length].emotion;
      selectedUrls.add(candidate.entry.url);
      queue.push({ ...candidate, emotion });
    }
  }

  const collected = [];
  const failed = [];
  const work = queue.slice(0, limit);
  let cursor = 0;
  const worker = async () => {
    while (cursor < work.length) {
      const candidate = work[cursor]; cursor += 1;
      try {
        const bytes = await fetchImage(fetchImpl, candidate.entry.url, wait);
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        const id = `bqb-${candidate.emotion}-${hash}`;
        const extension = detectedExtension(bytes);
        if (!extension) throw new Error('sticker image has unsupported content');
        const relativeFile = `assets/semantic/${candidate.emotion}/${hash}${extension}`;
        const destination = resolve(initialized.rootDir, ...relativeFile.split('/'));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { flag: 'wx' }).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
        if (!existingIds.has(id)) {
          manifest.stickers.push({
            id,
            file: relativeFile,
            emotion: candidate.emotion,
            intensity: 1,
            caption: candidate.caption,
            keywords: [...new Set(candidate.matches)],
            tags: [],
            contexts: [],
            source: { page: SOURCE_PAGE, url: candidate.entry.url, dataset: 'ChineseBQB' },
          });
          existingIds.add(id);
        }
        collected.push({ id, caption: candidate.caption, emotion: candidate.emotion, sourceUrl: candidate.entry.url });
      } catch (error) {
        failed.push({ url: candidate.entry.url, reason: error?.message ?? String(error) });
      }
      await wait(80);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, work.length) }, () => worker()));
  manifest.stickers = manifest.stickers.filter((item) => item.source?.dataset !== 'ChineseBQB' || !BLOCKED_TEXT.test(item.caption ?? ''));
  let chinese = manifest.stickers.filter((item) => item.source?.dataset === 'ChineseBQB');
  if (chinese.length > limit) {
    const kept = [];
    const keptIds = new Set();
    const ordered = [...chinese].sort((left, right) => left.id.localeCompare(right.id));
    for (const target of TARGETS) {
      const quota = quotas.get(target.emotion) ?? 0;
      for (const item of ordered.filter((candidate) => candidate.emotion === target.emotion).slice(0, quota)) {
        kept.push(item);
        keptIds.add(item.id);
      }
    }
    for (const item of ordered) {
      if (kept.length >= limit) break;
      if (!keptIds.has(item.id)) kept.push(item);
    }
    manifest.stickers = manifest.stickers.filter((item) => item.source?.dataset !== 'ChineseBQB');
    manifest.stickers.push(...kept);
    chinese = kept;
  }
  manifest.stickers.sort((left, right) => left.id.localeCompare(right.id));
  await writeFile(initialized.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const reportPath = join(initialized.rootDir, 'collection-sources.json');
  const catalog = chinese.map((item) => ({ id: item.id, caption: item.caption, emotion: item.emotion, sourceUrl: item.source?.url }));
  await writeFile(reportPath, `${JSON.stringify({ source: SOURCE_PAGE, index: INDEX_URL, collectedAt: new Date().toISOString(), catalog, collected, failed }, null, 2)}\n`, 'utf8');
  const retainedIds = new Set(retainedChinese.map((item) => item.id));
  const total = chinese.length;
  const finalAdded = chinese.filter((item) => !retainedIds.has(item.id)).length;
  const finalReused = chinese.filter((item) => retainedIds.has(item.id)).length;
  return {
    rootDir: initialized.rootDir,
    manifestPath: initialized.manifestPath,
    reportPath,
    total,
    added: finalAdded,
    reused: finalReused,
    collected: collected.length,
    failed: failed.length,
  };
}
