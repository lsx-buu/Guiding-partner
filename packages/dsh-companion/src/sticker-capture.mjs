import { randomUUID } from 'node:crypto';
import { createStickerAnnotator } from './sticker-annotator.mjs';

const MAX_BYTES = 10 * 1024 * 1024;

export function createStickerCapture({ stickerCatalog, annotator, logger = console } = {}) {
  if (!stickerCatalog || typeof stickerCatalog.addBuffer !== 'function') throw new TypeError('sticker catalog with addBuffer is required');
  const sessions = new Map();
  const queues = new Map();
  const keyFor = (event) => `${event?.routeId ?? ''}:${event?.ownerId ?? event?.route?.ownerId ?? ''}`;
  const fallbackAnnotator = annotator ?? createStickerAnnotator({ logger });
  const reply = (text) => ({ handled: true, replies: [text] });
  return {
    state(routeId, ownerId) { return sessions.get(`${routeId}:${ownerId}`) ?? null; },
    async process(event = {}) {
      const key = keyFor(event);
      const text = typeof event.normalizedText === 'string' ? event.normalizedText.trim().toLowerCase() : '';
      const active = sessions.get(key);
      if (text === '/bqb') {
        if (active) return reply('已经在收了，继续发吧。结束时发 /bqb_end。');
        sessions.set(key, { count: 0, duplicates: 0, startedAt: new Date().toISOString() });
        return reply('行，发来吧。结束时发 /bqb_end。');
      }
      if (text === '/bqb_end') {
        if (!active) return reply('还没开始收表情包呢。先发 /bqb。');
        sessions.delete(key);
        return reply(`收好了，这次新增 ${active.count} 张${active.duplicates ? `，重复 ${active.duplicates} 张` : ''}。`);
      }
      if (!active) return { handled: false };
      const images = Array.isArray(event.images) ? event.images : [];
      if (!images.length) return reply('继续发图就好，结束时发 /bqb_end。');
      let added = 0;
      let duplicates = 0;
      for (const image of images) {
        try {
          if (typeof image?.load !== 'function') throw new Error('sticker-image-loader');
          const bytes = Buffer.from(await image.load({ maxBytes: MAX_BYTES }));
          if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('sticker-oversize');
          const annotation = await fallbackAnnotator.annotate({ bytes, mediaType: image.mediaType });
          const result = await stickerCatalog.addBuffer(bytes, {
            ...annotation,
            channel: event.channel,
            messageId: event.messageId ?? randomUUID(),
            collectedAt: new Date().toISOString(),
          });
          if (!result.duplicate) { active.count += 1; added += 1; }
          else { active.duplicates += 1; duplicates += 1; }
        } catch (error) {
          logger.warn?.('[dsh-companion] sticker capture skipped image', error);
        }
      }
      if (added) return reply(`收下了，第 ${active.count} 张。`);
      if (duplicates) return reply(`这张已经有啦，目前收了 ${active.count} 张。`);
      return reply('这张没收进来，再发一张试试。');
    },
    handle(event = {}) {
      const key = keyFor(event);
      const previous = queues.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => this.process(event)).finally(() => {
        if (queues.get(key) === current) queues.delete(key);
      });
      queues.set(key, current);
      return current;
    },
  };
}
