const DAY = 86_400_000;
const HALF_LIFE = 7 * DAY;
const WINDOW = 30 * DAY;
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const weight = (age) => Math.exp(-Math.log(2) * Math.max(0, age) / HALF_LIFE);
function validZone(zone) { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); return true; } catch { return false; } }
function localDay(value, zone) { const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).reduce((out, part) => { out[part.type] = part.value; return out; }, {}); return `${parts.year}-${parts.month}-${parts.day}`; }

export function calculateRelationship({ events = [], plans = [], ownerId, at = new Date().toISOString(), timeZone = 'Asia/Shanghai' } = {}) {
  const end = Date.parse(at); const start = end - WINDOW;
  if (!Number.isFinite(end) || !validZone(timeZone)) return { ownerId, at, temperature: 0, status: 'quiet', lastPlanReplied: false, metrics: { replyRate: 0, initiationRate: 0, replySpeed: 0, ignorePenalty: 1, consecutiveUnansweredPlans: 0, explicitFeedbackAdjustment: 0 }, explanation: 'invalid-at-or-time-zone' };
  const relevantEvents = events.filter((event) => event.owner_id === undefined || event.owner_id === ownerId).filter((event) => Date.parse(event.occurred_at) >= start && Date.parse(event.occurred_at) <= end);
  const relevantPlans = plans.filter((plan) => plan.owner_id === undefined || plan.owner_id === ownerId).filter((plan) => Date.parse(plan.sent_at) >= start && Date.parse(plan.sent_at) <= end && plan.sent === 1);
  const replies = new Map();
  for (const plan of relevantPlans) {
    const reply = relevantEvents.filter((event) => event.kind === 'reply' && event.plan_id === plan.plan_id && Date.parse(event.occurred_at) >= Date.parse(plan.sent_at) && Date.parse(event.occurred_at) - Date.parse(plan.sent_at) <= 6 * 60 * 60 * 1000).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))[0];
    if (reply) replies.set(plan.plan_id, reply);
  }
  const scoredPlans = relevantPlans.filter((plan) => replies.has(plan.plan_id) || end - Date.parse(plan.sent_at) >= 6 * 60 * 60 * 1000);
  const replySamples = scoredPlans.map((plan) => ({ plan, reply: replies.get(plan.plan_id) })).filter(({ reply }) => reply);
  const weightedMean = (values) => values.length ? values.reduce((sum, value) => sum + value.value * value.weight, 0) / values.reduce((sum, value) => sum + value.weight, 0) : 0.5;
  const replyRate = weightedMean(scoredPlans.map((plan) => ({ value: replies.has(plan.plan_id) ? 1 : 0, weight: weight(end - Date.parse(plan.sent_at)) })));
  const replySpeed = weightedMean(replySamples.map(({ plan, reply }) => ({ value: clamp(1 - (Date.parse(reply.occurred_at) - Date.parse(plan.sent_at)) / (6 * 60 * 60 * 1000)), weight: weight(end - Date.parse(reply.occurred_at)) })));
  const days = new Map();
  for (const plan of relevantPlans) { const day = localDay(plan.sent_at, timeZone); days.set(day, days.get(day) ?? []); }
  for (const event of relevantEvents) { const day = localDay(event.occurred_at, timeZone); days.set(day, [...(days.get(day) ?? []), event]); }
  const dayWeights = [...days.entries()].map(([day, dayEvents]) => ({ day, events: dayEvents, weight: weight(end - Date.parse(`${day}T12:00:00.000Z`)) }));
  const initiationRate = dayWeights.length ? dayWeights.reduce((sum, item) => sum + (item.events.some((event) => event.kind === 'user_initiated') ? item.weight : 0), 0) / dayWeights.reduce((sum, item) => sum + item.weight, 0) : 0.5;
  let consecutiveUnansweredPlans = 0;
  const maturePlans = [...relevantPlans].filter((plan) => end - Date.parse(plan.sent_at) >= 6 * 60 * 60 * 1000).sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
  for (const plan of maturePlans) {
    if (replies.has(plan.plan_id)) break;
    consecutiveUnansweredPlans += 1;
  }
  const ignorePenalty = relevantPlans.length ? Math.min(consecutiveUnansweredPlans / 3, 1) : 0.5;
  const latestFeedback = relevantEvents.filter((event) => event.feedback === 'explicit_positive' || event.feedback === 'explicit_negative').sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0];
  const explicitFeedbackAdjustment = latestFeedback?.feedback === 'explicit_positive' ? 0.15 : latestFeedback?.feedback === 'explicit_negative' ? -0.30 : 0;
  const base = 0.35 * replyRate + 0.25 * initiationRate + 0.20 * replySpeed + 0.20 * (1 - ignorePenalty);
  const temperature = clamp(base + explicitFeedbackAdjustment);
  const status = temperature < 0.35 || consecutiveUnansweredPlans >= 3 ? 'quiet' : temperature < 0.70 ? 'normal' : 'warm';
  const newestPlan = [...relevantPlans].sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))[0];
  return { ownerId, at, temperature, status, lastPlanReplied: Boolean(newestPlan && replies.has(newestPlan.plan_id)), metrics: { replyRate, initiationRate, replySpeed, ignorePenalty, consecutiveUnansweredPlans, explicitFeedbackAdjustment }, explanation: `replyRate=${replyRate.toFixed(3)}, initiationRate=${initiationRate.toFixed(3)}, replySpeed=${replySpeed.toFixed(3)}, ignorePenalty=${ignorePenalty.toFixed(3)}` };
}
