import { createHash } from 'node:crypto';

const WINDOWS = { morning: ['07:00', '10:30'], topic: ['11:00', '20:30'], evening: ['21:00', '23:59'] };
const parts = (value, timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(value)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
const validZone = (zone) => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); return true; } catch { return false; } };
export const localDateFor = (value, zone) => { const p = parts(value, zone); return `${p.year}-${p.month}-${p.day}`; };
const hashFraction = (value) => parseInt(createHash('sha256').update(value).digest('hex').slice(0, 12), 16) / 0xffffffffffff;
function resolveLocal(date, minute, zone) {
  const [year, month, day] = date.split('-').map(Number); const target = minute; const approx = Date.UTC(year, month - 1, day, Math.floor(target / 60), target % 60);
  for (let delta = -18 * 3600_000; delta <= 18 * 3600_000; delta += 60_000) { const candidate = new Date(approx + delta); const p = parts(candidate, zone); if (`${p.year}-${p.month}-${p.day}` === date && Number(p.hour) * 60 + Number(p.minute) === target) return candidate; }
  for (let delta = 0; delta <= 6 * 3600_000; delta += 60_000) { const candidate = new Date(approx + delta); const p = parts(candidate, zone); if (`${p.year}-${p.month}-${p.day}` === date && Number(p.hour) * 60 + Number(p.minute) >= target) return candidate; }
  return new Date(approx);
}
export function scheduleWindow({ ownerId, profile, at = new Date().toISOString(), windowKind } = {}) {
  if (typeof ownerId !== 'string' || !ownerId.trim() || !validZone(profile?.time_zone) || !WINDOWS[windowKind] || !Number.isFinite(Date.parse(at))) throw new TypeError('invalid scheduler input');
  const date = localDateFor(at, profile.time_zone); const [start, end] = WINDOWS[windowKind]; const parse = (x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; }; const startMin = parse(start); const endMin = parse(end);
  const scheduledMin = startMin + Math.floor(hashFraction(`${ownerId}:${date}:${windowKind}`) * Math.max(1, endMin - startMin));
  const scheduled = resolveLocal(date, scheduledMin, profile.time_zone); const windowEnd = resolveLocal(date, endMin, profile.time_zone); const expires = new Date(Math.min(windowEnd.getTime(), scheduled.getTime() + 90 * 60_000));
  return { ownerId, localDate: date, windowKind, scheduledAt: scheduled.toISOString(), expiresAt: expires.toISOString() };
}
export { WINDOWS, validZone };
