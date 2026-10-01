const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60 * 60 * 1_000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Cache iLink typing tickets per user while keeping getConfig failures non-fatal. */
export function createWeixinConfigCache({
  clock = () => Date.now(),
  ttlMs = DAY_MS,
  retryBaseMs = DEFAULT_RETRY_MS,
  retryMaxMs = MAX_RETRY_MS,
} = {}) {
  const entries = new Map();

  async function getTypingTicket(userId, contextToken, load) {
    const key = nonEmptyString(userId);
    if (!key || typeof load !== 'function') return '';
    const now = Number(clock());
    const entry = entries.get(key);
    if (entry?.ticket && entry.expiresAt > now) return entry.ticket;
    if (entry?.nextRetryAt > now) return '';
    try {
      const response = await load({ userId: key, contextToken });
      const ticket = nonEmptyString(response?.typing_ticket ?? response);
      if (!ticket) throw new Error('typing ticket missing');
      entries.set(key, {
        ticket,
        expiresAt: now + Math.min(Math.max(0, ttlMs), DAY_MS),
        failures: 0,
        nextRetryAt: 0,
      });
      return ticket;
    } catch {
      const failures = (entry?.failures ?? 0) + 1;
      const delay = Math.min(
        Math.max(0, retryMaxMs),
        Math.max(0, retryBaseMs) * (2 ** (failures - 1)),
      );
      entries.set(key, { ticket: '', failures, nextRetryAt: now + delay, expiresAt: 0 });
      return '';
    }
  }

  return Object.freeze({
    getTypingTicket,
    clear(userId) {
      const key = nonEmptyString(userId);
      if (key) entries.delete(key);
    },
  });
}
