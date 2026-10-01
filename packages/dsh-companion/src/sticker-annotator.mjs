const EMOTIONS = new Set(['happy', 'sad', 'angry_playful', 'comfort', 'surprised', 'teasing']);

export function detectStickerMediaType(bytes) {
  const value = Buffer.from(bytes ?? []);
  if (value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (value.length >= 3 && value[0] === 255 && value[1] === 216 && value[2] === 255) return 'image/jpeg';
  const head = value.subarray(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function parseStickerAnnotation(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    const match = parsed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('sticker-annotation-json');
    parsed = JSON.parse(match[0]);
  }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype
    || Object.keys(parsed).some((key) => !['emotion', 'caption', 'keywords'].includes(key))
    || !EMOTIONS.has(parsed.emotion)
    || typeof parsed.caption !== 'string' || !parsed.caption.trim() || parsed.caption.length > 240
    || !Array.isArray(parsed.keywords) || parsed.keywords.length > 6
    || parsed.keywords.some((item) => typeof item !== 'string' || !item.trim() || item.length > 40)) {
    throw new Error('sticker-annotation-object');
  }
  return {
    emotion: parsed.emotion,
    caption: parsed.caption.trim(),
    keywords: [...new Set(parsed.keywords.map((item) => item.trim()))],
  };
}

export function fallbackStickerAnnotation() {
  return { emotion: 'teasing', caption: '这个表情先收着', keywords: ['表情', '搞怪'] };
}

export function createStickerAnnotator({ ask, logger = console } = {}) {
  return {
    async annotate({ bytes } = {}) {
      if (typeof ask !== 'function') return fallbackStickerAnnotation();
      try {
        const mediaType = detectStickerMediaType(bytes);
        if (!mediaType) throw new Error('sticker-format');
        const result = await ask({
          content: [
            { type: 'text', text: '请识别这张表情包，只输出严格 JSON：{"emotion":"happy|sad|angry_playful|comfort|surprised|teasing","caption":"简短中文","keywords":["最多6个关键词"]}。' },
            { type: 'image', mediaType, data: Buffer.from(bytes ?? []).toString('base64') },
          ],
        });
        return parseStickerAnnotation(result?.answer ?? result?.output_text ?? result);
      } catch (error) {
        logger.warn?.('[dsh-companion] sticker annotation failed; using fallback', error);
        return fallbackStickerAnnotation();
      }
    },
  };
}

export function createHarnessStickerAnnotator({ harness, logger = console } = {}) {
  const createSession = harness?.createSession?.bind(harness);
  const ask = harness?.ask?.bind(harness);
  if (!createSession || !ask) throw new TypeError('sticker annotator Harness is incomplete');
  return createStickerAnnotator({
    logger,
    ask: async ({ content }) => {
      const sessionId = await createSession({ purpose: 'companion-sticker-annotation' });
      return ask(sessionId, content);
    },
  });
}
