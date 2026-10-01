const MODES = {
  gentle: { budget: 1, maxBubbles: 1, followUp: false, minInterval: 12 * 3600_000 },
  natural: { budget: 2, maxBubbles: 1, followUp: true, minInterval: 4 * 3600_000 },
  clingy: { budget: 3, maxBubbles: 2, followUp: true, minInterval: 2 * 3600_000 },
};
function validZone(zone) { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); return true; } catch { return false; } }
function localParts(at, zone) { return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).reduce((out, part) => { out[part.type] = part.value; return out; }, {}); }
function quietNow(at, zone, start, end) { const parts = localParts(at, zone); const minutes = Number(parts.hour) * 60 + Number(parts.minute); const parse = (value) => { const [hour, minute] = String(value).split(':').map(Number); return hour * 60 + minute; }; const from = parse(start); const to = parse(end); return from === to ? true : from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to; }
export function evaluatePolicy({ profile, relationship, plans = [], at, reason, proactiveState = 'enabled', requestedBubbles = 1 } = {}) {
  if (!['morning', 'topic', 'evening', 'follow-up'].includes(reason)) return { allowed: false, reason: 'invalid-reason' };
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return { allowed: false, reason: 'invalid-at' };
  const mode = MODES[profile?.interaction_mode]; const zone = profile?.time_zone;
  if (!mode) return { allowed: false, reason: 'invalid-interaction-mode' };
  if (!zone || !validZone(zone)) return { allowed: false, reason: 'invalid-time-zone' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(profile?.quiet_hours_start ?? '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(profile?.quiet_hours_end ?? '')) return { allowed: false, reason: 'invalid-quiet-hours' };
  if (proactiveState !== 'enabled') return { allowed: false, reason: 'paused' };
  const status = relationship?.status ?? 'normal'; const quiet = status === 'quiet';
  if (quietNow(at, zone, profile.quiet_hours_start, profile.quiet_hours_end)) return { allowed: false, reason: 'quiet-hours', status };
  const local = localParts(at, zone); const localDate = `${local.year}-${local.month}-${local.day}`;
  const occupying = new Set(['planned', 'claimed', 'sending', 'sent']);
  const occupiesBudget = (plan) => occupying.has(plan.status) || ((plan.status === 'delivery_unknown' || plan.status === 'failed_final') && Boolean(plan.has_attempt ?? plan.attempted));
  const todayCount = plans.filter((plan) => occupiesBudget(plan) && localParts(plan.scheduled_at ?? plan.created_at, zone) && `${localParts(plan.scheduled_at ?? plan.created_at, zone).year}-${localParts(plan.scheduled_at ?? plan.created_at, zone).month}-${localParts(plan.scheduled_at ?? plan.created_at, zone).day}` === localDate).length;
  const configuredBudget = profile?.daily_budget === undefined
    ? 3
    : Number.isInteger(profile.daily_budget) && profile.daily_budget >= 1 && profile.daily_budget <= 3 ? profile.daily_budget : 0;
  if (!configuredBudget) return { allowed: false, reason: 'invalid-daily-budget' };
  const budget = Math.min(configuredBudget, quiet ? 1 : mode.budget + (mode === MODES.natural && status === 'warm' ? 1 : 0));
  if (todayCount >= budget) return { allowed: false, reason: 'daily-budget-exhausted', status, budget, todayCount };
  const maxBubbles = quiet ? 1 : mode === MODES.gentle ? 1 : status === 'warm' ? 3 : mode.maxBubbles;
  if (requestedBubbles < 1 || requestedBubbles > maxBubbles) return { allowed: false, reason: 'bubble-limit', status, maxBubbles };
  if (reason === 'follow-up') {
    if (!mode.followUp || status === 'quiet' || (profile.interaction_mode === 'natural' && status !== 'warm')) return { allowed: false, reason: 'follow-up-not-eligible', status };
    if (!plans.some((plan) => plan.status === 'sent')) return { allowed: false, reason: 'follow-up-no-sent-plan', status };
    if (relationship?.lastPlanReplied) return { allowed: false, reason: 'follow-up-already-replied', status };
    const latestRegular = [...plans].filter((plan) => plan.reason !== 'follow-up' && plan.scheduled_at).sort((a, b) => Date.parse(b.scheduled_at) - Date.parse(a.scheduled_at))[0];
    if (plans.some((plan) => plan.reason === 'follow-up' && occupiesBudget(plan) && (!latestRegular || Date.parse(plan.scheduled_at) >= Date.parse(latestRegular.scheduled_at)))) return { allowed: false, reason: 'follow-up-already-used', status };
  }
  const latest = [...plans].filter((plan) => occupiesBudget(plan) && (plan.scheduled_at ?? plan.created_at)).sort((a, b) => Date.parse(b.scheduled_at ?? b.created_at) - Date.parse(a.scheduled_at ?? a.created_at))[0];
  if (reason !== 'follow-up' && latest && Date.parse(at) - Date.parse(latest.scheduled_at ?? latest.created_at) < mode.minInterval) return { allowed: false, reason: 'minimum-interval', status, minIntervalMs: mode.minInterval };
  if (quiet && relationship.metrics?.consecutiveUnansweredPlans >= 3) { const cooldown = relationship.metrics.consecutiveUnansweredPlans >= 5 ? 72 : relationship.metrics.consecutiveUnansweredPlans === 4 ? 48 : 24; if (latest && Date.parse(at) - Date.parse(latest.created_at) < cooldown * 3600_000) return { allowed: false, reason: `quiet-cooldown-${cooldown}h`, status, cooldownHours: cooldown }; }
  return { allowed: true, status, budget, todayCount, maxBubbles, minIntervalMs: mode.minInterval };
}
export { MODES, validZone, quietNow };
