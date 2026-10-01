import { randomUUID } from 'node:crypto';
import { openCompanionDatabase } from './database.mjs';
import { CompanionStore } from './store.mjs';
import { calculateRelationship } from './relationship.mjs';
import { evaluatePolicy } from './policy.mjs';
import { normalizeBubbles, validatePlayfulAngry } from './persona.mjs';
import { projectMemory, normalizeMemory } from './memory.mjs';
import { localDateFor, scheduleWindow } from './scheduler.mjs';
import { buildCompanionPrompt } from './persona.mjs';
import { rewriteTopicQuery, rankTopicResults } from './topic.mjs';
import { inferStickerIntent } from './sticker.mjs';

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function retryDelayMs(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.min(5 * 60_000, Math.max(1_000, parsed)) : 60_000; }
function gatewayEventId(event) {
  const messageId = typeof event?.messageId === 'string' ? event.messageId.trim() : '';
  return messageId
    ? `gateway-message:${event.routeId}:${messageId}`
    : `gateway-event:${event.routeId}:${event.occurredAt}:${event.cursor}`;
}
const SERIOUS_REPLY = /自杀|自残|轻生|去世|病危|报警|被打|强奸|家暴|诈骗|急救/;
const TECHNICAL_REPLY = /```|https?:\/\/|(^|\n)#{1,6}\s|[A-Za-z]:\\|\/companion\b/;

function normalizeReplyStickerOptions(value = {}) {
  return {
    enabled: value?.enabled === true,
    probability: Math.min(1, Math.max(0, Number(value?.probability ?? 0.6))),
    forceAfterEligibleMisses: Math.max(0, Math.floor(Number(value?.forceAfterEligibleMisses ?? 2))),
    minIntervalMs: Math.max(0, Number(value?.minIntervalMs ?? 0)),
    delayMs: Math.max(0, Math.min(5_000, Number(value?.delayMs ?? 450))),
  };
}

function replyIsStickerEligible(event) {
  const input = String(event?.inputText ?? '').trim();
  const output = String(event?.outputText ?? '').trim();
  const combined = `${input}\n${output}`;
  return Boolean(input && output && input.length <= 600 && output.length <= 500
    && !SERIOUS_REPLY.test(combined) && !TECHNICAL_REPLY.test(combined));
}

export async function createCompanionCore({ databasePath = ':memory:', gateway, workerId = randomUUID(), now = () => new Date().toISOString(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random, logger = console, generator, topicProvider, stickerCatalog, memoryExtractor, replySticker, timer = globalThis } = {}) {
  const db = await openCompanionDatabase(databasePath);
  const store = new CompanionStore(db, now);
  store.recover(now());
  store.recoverCandidates(now());
  let currentGateway = null;
  let offInbound = null;
  let offRoute = null;
  let offConversationReply = null;
  let attaching = Promise.resolve();
  let closed = false;
  let state = 'inactive';
  const activeRuns = new Set();
  let workerTimer = null;
  let ticking = null;
  let currentGenerator = generator;
  let currentTopicProvider = topicProvider;
  let currentStickerCatalog = stickerCatalog;
  let currentMemoryExtractor = memoryExtractor;
  const replyStickerOptions = normalizeReplyStickerOptions(replySticker);
  const replyStickerStates = new Map();

  async function sendReplySticker(event) {
    if (closed || state !== 'active' || !currentGateway || !currentStickerCatalog || !replyIsStickerEligible(event)) return;
    const gatewayAtStart = currentGateway;
    const route = gatewayAtStart.getRoute(event.routeId);
    if (!route || route.status !== 'active' || route.routeVersion !== event.routeVersion || route.inboundVersion !== event.inboundVersion) return;
    const stateForOwner = replyStickerStates.get(route.ownerId) ?? { misses: 0, lastSentAt: 0 };
    const timestamp = Date.parse(now());
    if (timestamp - stateForOwner.lastSentAt < replyStickerOptions.minIntervalMs) return;
    const forced = stateForOwner.misses >= replyStickerOptions.forceAfterEligibleMisses;
    if (!forced && Number(random()) >= replyStickerOptions.probability) {
      stateForOwner.misses += 1;
      replyStickerStates.set(route.ownerId, stateForOwner);
      return;
    }
    try {
      const capabilities = await gatewayAtStart.getCapabilities(route.routeId);
      const query = `${event.outputText}\n${event.inputText}`;
      const intent = inferStickerIntent(query, { context: 'reply' });
      const selected = currentStickerCatalog.select(intent, { capabilities, recentUsage: store.recentStickerUsage(route.ownerId) });
      if (!selected) return;
      const file = await currentStickerCatalog.materialize(selected.id);
      if (replyStickerOptions.delayMs) await wait(replyStickerOptions.delayMs);
      const latest = currentGateway?.getRoute(route.routeId);
      if (closed || currentGateway !== gatewayAtStart || !latest || latest.status !== 'active'
        || latest.routeVersion !== event.routeVersion || latest.inboundVersion !== event.inboundVersion) return;
      const receipt = await gatewayAtStart.send(route.routeId, { kind: 'sticker', stickerId: selected.id, file }, {
        idempotencyKey: `conversation-reply-sticker:${route.routeId}:${event.messageId ?? event.inboundVersion}`,
      });
      if ((receipt?.deliveryOutcome ?? 'sent') === 'sent') {
        store.recordStickerUsage(route.ownerId, selected.id);
        replyStickerStates.set(route.ownerId, { misses: 0, lastSentAt: timestamp });
        logger.info?.(`[dsh-companion] conversational sticker sent: ${selected.id}`);
      }
    } catch (error) {
      stateForOwner.misses += 1;
      replyStickerStates.set(route.ownerId, stateForOwner);
      logger.warn?.(`[dsh-companion] conversational sticker skipped: ${error?.code ?? error?.message ?? 'delivery-failed'}`);
    }
  }

  function handleConversationReply(event) {
    if (!replyStickerOptions.enabled) return;
    const run = Promise.resolve().then(() => sendReplySticker(event))
      .catch((error) => logger.warn?.('[dsh-companion] conversational sticker failed', error));
    activeRuns.add(run);
    run.finally(() => activeRuns.delete(run));
  }

  function handleInbound(event) {
    attaching = attaching.then(() => {
      const route = currentGateway?.getRoute(event.routeId);
      if (!route) return;
      const ownerId = route.ownerId;
      const recorded = store.transaction(() => {
        const eventCursor = Number(event.cursor);
        if (!Number.isSafeInteger(eventCursor) || eventCursor <= Number(store.cursor().cursor)) return null;
        store.route(route);
        const eventId = gatewayEventId(event);
        if (store.recordInbound({ ...event, event_id: eventId }, ownerId).inserted) {
          if (event.controlIntent === 'pause_proactive') store.setControl(ownerId, 'paused', event.controlIntent);
          if (event.controlIntent === 'resume_proactive') store.setControl(ownerId, 'enabled', event.controlIntent);
          store.cancelPlans(ownerId, 'inbound');
          store.cancelFollowUpCandidates(ownerId, 'inbound');
          store.advanceCursor(event.cursor, 'active');
          return { eventId, text: event.normalizedText };
        }
        return null;
      });
      if (recorded && currentMemoryExtractor && !event.controlIntent
        && store.memoryControl(ownerId).memory_state === 'enabled'
        && typeof recorded.text === 'string' && recorded.text.trim()
        && recorded.text.length <= 4_000) {
        return Promise.resolve(currentMemoryExtractor.extract({
          ownerId,
          text: recorded.text,
          existing: store.memories(ownerId, { status: 'active' }).slice(0, 20),
        })).then((value) => {
          const memories = Array.isArray(value) ? value : value?.memories;
          if (!Array.isArray(memories)) throw new TypeError('memory extractor returned invalid output');
          for (const memory of memories.slice(0, 3)) {
            const expiresAt = new Date(Date.parse(now()) + Number(memory.ttlDays) * 86_400_000).toISOString();
            store.remember({
              owner_id: ownerId,
              kind: memory.kind,
              summary: memory.summary,
              confidence: memory.confidence,
              sensitivity: memory.sensitivity,
              evidence_event_id: recorded.eventId,
              expires_at: expiresAt,
            });
          }
        }).catch((error) => logger.warn?.(`[dsh-companion] memory extraction skipped: ${error?.code ?? 'invalid-output'}`));
      }
      return undefined;
    }).catch((error) => logger.error?.('[dsh-companion] inbound handling failed', error));
    return attaching;
  }
  function handleRoute(event) {
    attaching = attaching.then(() => {
      const route = event.route ?? event;
      if (!route?.ownerId) return;
      store.transaction(() => { store.route(route); if (route.status !== 'active') store.cancelPlans(route.ownerId, 'route_changed'); });
    }).catch((error) => logger.error?.('[dsh-companion] route handling failed', error));
    return attaching;
  }
  async function replay() {
    let cursorRow = store.cursor();
    let cursor = cursorRow.cursor;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        for (const route of currentGateway.listRoutes?.() ?? []) store.route(route);
        while (true) {
          const previousCursor = cursor;
          const page = await currentGateway.readInboundSince(cursor, 100);
          for (const event of page.events ?? []) await handleInbound(event);
          cursor = page.nextCursor ?? cursor;
          if (!page.events?.length || (cursor === previousCursor && page.events.length < 100) || page.events.length < 100) break;
        }
        state = cursorRow.state === 'needs_resync' ? 'inactive-needs-resync' : 'active';
        return;
      } catch (error) {
        const journal = currentGateway.getJournalState?.();
        const gatewayCursor = Number(journal?.currentCursor);
        const storedCursor = Number(cursorRow.cursor);
        const journalStartsAtBeginning = journal?.oldestCursor === null || journal?.oldestCursor === '1';
        const isGatewayRestart = error?.code === 'invalid_cursor'
          && Number.isSafeInteger(gatewayCursor) && Number.isSafeInteger(storedCursor)
          && gatewayCursor < storedCursor && journalStartsAtBeginning;
        if (isGatewayRestart && attempt === 0) {
          store.rebaseCursorAfterGatewayRestart('0');
          cursorRow = store.cursor();
          cursor = cursorRow.cursor;
          logger.info?.(`[dsh-companion] gateway restart detected; inbound cursor rebased from ${storedCursor} to 0`);
          continue;
        }
        if (error?.code === 'cursor_expired' || error?.code === 'invalid_cursor') {
          store.setCursor(cursor, 'needs_resync'); state = 'inactive-needs-resync'; return;
        }
        throw error;
      }
    }
  }
  async function attach(nextGateway) {
    await detach();
    if (!nextGateway) { state = 'inactive'; return; }
    currentGateway = nextGateway;
    offInbound = nextGateway.onInbound(handleInbound);
    offRoute = nextGateway.onRouteChanged(handleRoute);
    offConversationReply = nextGateway.onConversationReply?.(handleConversationReply) ?? null;
    await replay();
  }
  async function detach() {
    offInbound?.(); offRoute?.(); offConversationReply?.(); offInbound = null; offRoute = null; offConversationReply = null; currentGateway = null; state = 'inactive'; await attaching;
  }
  async function queuePlan({ routeId, reason, scheduledAt, expiresAt, messages, memoryIds = [] }) {
    if (!currentGateway || state !== 'active') throw new Error('Companion gateway is not active');
    const route = currentGateway.getRoute(routeId);
    if (!route || route.status !== 'active') throw new Error('Companion route is not active');
    return store.queue({ route, reason, scheduledAt, expiresAt, messages, memoryIds });
  }
  async function runOnceInner() {
    if (closed || state !== 'active' || !currentGateway) return null;
    const plan = store.claim(workerId, now());
    if (!plan) return null;
    const gatewayAtClaim = currentGateway;
    if (closed || state !== 'active' || !gatewayAtClaim) { store.cancelPlan(plan.plan_id, 'companion-inactive'); return store.inspect(plan.plan_id); }
    let route; let health; const control = store.control(plan.owner_id);
    try { route = gatewayAtClaim.getRoute(plan.route_id); health = route ? await gatewayAtClaim.getHealth(plan.route_id) : null; } catch {
      store.cancelPlan(plan.plan_id, 'preflight-error'); return store.inspect(plan.plan_id);
    }
    if (closed || state !== 'active' || currentGateway !== gatewayAtClaim || !route || route.status !== 'active' || route.routeVersion !== plan.route_version || route.inboundVersion !== plan.inbound_version || control.state !== 'enabled' || store.cursor().state !== 'active' || !health || !['online', 'ok'].includes(health.status)) {
      store.cancelPlan(plan.plan_id, 'route-or-control-changed');
      return store.inspect(plan.plan_id);
    }
    for (const [index, message] of store.messages(plan.plan_id).filter((item) => item.status === 'pending').entries()) {
      const content = JSON.parse(message.content_json);
      if (index > 0 && content.delayMs) await wait(content.delayMs);
      const gatewayAtPreflight = currentGateway;
      if (closed || state !== 'active' || !gatewayAtPreflight) { store.cancelPlan(plan.plan_id, 'companion-inactive'); break; }
      const currentTime = now();
      let latest; let latestHealth;
      try { latest = gatewayAtPreflight.getRoute(plan.route_id); latestHealth = latest ? await gatewayAtPreflight.getHealth(plan.route_id) : null; } catch {
        store.cancelPlan(plan.plan_id, 'preflight-error'); break;
      }
      const refs = JSON.parse(plan.memory_refs_json ?? '[]');
      const memoriesValid = refs.length === 0 || (store.memoryControl(plan.owner_id).memory_state === 'enabled' && refs.every((id) => store.memories(plan.owner_id, { status: 'active' }).some((memory) => memory.memory_id === id && Date.parse(memory.expires_at) > Date.parse(plan.scheduled_at))));
      const currentMessage = store.messages(plan.plan_id).find((item) => item.message_id === message.message_id);
      if (closed || state !== 'active' || currentGateway !== gatewayAtPreflight || !latest || latest.status !== 'active' || latest.ownerId !== plan.owner_id || latest.routeVersion !== plan.route_version || latest.inboundVersion !== plan.inbound_version || store.control(plan.owner_id).state !== 'enabled' || store.cursor().state !== 'active' || !latestHealth || !['online', 'ok'].includes(latestHealth.status) || !memoriesValid || !currentMessage || currentMessage.status !== 'pending' || Date.parse(currentTime) < Date.parse(plan.scheduled_at) || Date.parse(currentTime) >= Date.parse(plan.expires_at)) { store.cancelPlan(plan.plan_id, 'preflight'); break; }
      let outboundContent = content;
      if (content.kind === 'sticker') {
        try {
          const capabilities = await gatewayAtPreflight.getCapabilities(plan.route_id);
          if (!currentStickerCatalog || (!capabilities?.sticker && !capabilities?.image)) {
            store.skipMessage(message.message_id, plan.plan_id, 'sticker-unavailable');
            continue;
          }
          const file = await currentStickerCatalog.materialize(content.stickerId);
          const routeAfterMaterialize = currentGateway?.getRoute(plan.route_id);
          if (currentGateway !== gatewayAtPreflight || !routeAfterMaterialize
            || routeAfterMaterialize.status !== 'active'
            || routeAfterMaterialize.routeVersion !== plan.route_version
            || routeAfterMaterialize.inboundVersion !== plan.inbound_version) {
            store.cancelPlan(plan.plan_id, 'route-changed-during-sticker-load');
            break;
          }
          outboundContent = { ...content, file };
        } catch {
          store.skipMessage(message.message_id, plan.plan_id, 'sticker-materialization-failed');
          continue;
        }
      }
      const key = message.idempotency_key;
      const attemptId = randomUUID();
      store.markSending(message.message_id, plan.plan_id, attemptId, key);
      let receipt; let outcome;
      try {
        receipt = await gatewayAtPreflight.send(plan.route_id, outboundContent, { idempotencyKey: key });
        outcome = receipt?.deliveryOutcome ?? 'sent';
        if (!['sent', 'unknown', 'rate_limited'].includes(outcome)) outcome = 'failed_final';
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { store.finish(message.message_id, plan.plan_id, 'unknown', { reason: 'aborted-after-attempt' }); throw error; }
        if (['artifact-delivery-uncertain', 'network-error', 'timeout', 'invalid-response'].includes(error?.code)) outcome = 'unknown';
        else if (error?.code === 'rate_limited' || error?.code === 'http-429' || (error?.code === 'http-error' && error?.status === 429) || error?.status === 429) outcome = 'rate_limited';
        else if (['inactive_route', 'unknown_route', 'adapter_unavailable'].includes(error?.code)) outcome = 'cancelled';
        else outcome = 'failed_final';
        receipt = { reason: error?.code ?? 'delivery-failed', ...(outcome === 'rate_limited' && error?.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
      }
      if (outcome === 'rate_limited') {
        const retryAt = new Date(Date.parse(now()) + retryDelayMs(receipt?.retryAfterMs)).toISOString();
        if (Number(plan.retry_count ?? 0) < 1 && Date.parse(retryAt) < Date.parse(plan.expires_at)) {
          store.deferRateLimit(message.message_id, plan.plan_id, retryAt, { reason: 'rate_limited', retryAt });
          break;
        }
        outcome = 'failed_final';
        receipt = { reason: 'rate-limit-retry-exhausted' };
      }
      store.finish(message.message_id, plan.plan_id, outcome, receipt);
      if (outcome === 'sent' && content.kind === 'sticker') {
        store.recordStickerUsage(plan.owner_id, content.stickerId);
      }
      if (outcome !== 'sent') break;
    }
    store.settlePlan(plan.plan_id);
    return store.inspect(plan.plan_id);
  }
  async function runOnce() {
    const run = runOnceInner();
    activeRuns.add(run);
    try { return await run; } finally { activeRuns.delete(run); }
  }
  async function ensureCandidates(ownerId) {
    if (!currentGateway || state !== 'active') return [];
    const routes = (currentGateway.listRoutes?.() ?? []).filter((route) => route.ownerId === ownerId && route.status === 'active'); const profile = service.getProfile(ownerId); const created = [];
    for (const windowKind of ['morning', 'topic', 'evening']) { const window = scheduleWindow({ ownerId, profile, at: now(), windowKind }); const candidate = store.upsertCandidate({ candidateId: randomUUID(), ownerId, routeId: routes[0]?.routeId, localDate: window.localDate, windowKind, scheduledAt: window.scheduledAt, expiresAt: window.expiresAt }); created.push(candidate); }
    return created;
  }
  async function ensureFollowUp(ownerId) {
    if (!currentGateway || state !== 'active') return null;
    const profile = service.getProfile(ownerId);
    if (!profile || profile.interaction_mode === 'gentle') return null;
    const latest = store.latestSentPlan(ownerId);
    if (!latest || store.planHasReply(latest.plan_id)) return null;
    const relationship = service.getRelationship(ownerId, now());
    if (relationship.status === 'quiet' || (profile.interaction_mode === 'natural' && relationship.status !== 'warm')) return null;
    const since = new Date(Date.parse(now()) - 30 * 86_400_000).toISOString();
    const latencies = store.replyLatencies(ownerId, since);
    const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
    const waitMs = profile.interaction_mode === 'clingy'
      ? Math.min(90 * 60_000, Math.max(20 * 60_000, median ?? 45 * 60_000))
      : Math.min(3 * 60 * 60_000, Math.max(45 * 60_000, median === null ? 90 * 60_000 : 1.5 * median));
    const scheduledAt = new Date(Date.parse(latest.sent_at) + waitMs).toISOString();
    const expiresAt = new Date(Date.parse(scheduledAt) + 90 * 60_000).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(now())) return null;
    const regularConflict = store.candidates(ownerId, ['pending']).some((candidate) => candidate.window_kind !== 'follow_up' && Date.parse(candidate.scheduled_at) >= Date.parse(scheduledAt) && Date.parse(candidate.scheduled_at) - Date.parse(scheduledAt) <= 2 * 60 * 60_000);
    if (regularConflict) return null;
    return store.upsertCandidate({ candidateId: randomUUID(), ownerId, routeId: latest.route_id, localDate: localDateFor(scheduledAt, profile.time_zone), windowKind: 'follow_up', scheduledAt, expiresAt });
  }
  async function tickInternal() {
    store.recoverCandidates(now());
    if (!currentGenerator) return { status: 'inactive-no-generator', generated: 0 };
    if (!currentGateway || state !== 'active') return { status: 'inactive', generated: 0 };
    const routes = currentGateway.listRoutes?.() ?? []; const owners = [...new Set(routes.filter((route) => route.status === 'active').map((route) => route.ownerId))]; let generated = 0;
    for (const ownerId of owners) await ensureCandidates(ownerId);
    for (const ownerId of owners) await ensureFollowUp(ownerId);
    for (const ownerId of owners) {
      const candidate = store.candidates(ownerId, ['pending']).find((item) => Date.parse(item.scheduled_at) <= Date.parse(now()) && Date.parse(item.expires_at) > Date.parse(now())); if (!candidate) continue;
      const claimed = store.claimCandidate(candidate.candidate_id, workerId); if (!claimed) continue;
      try {
        const planReason = claimed.window_kind === 'follow_up' ? 'follow-up' : claimed.window_kind;
        const route = currentGateway.getRoute(claimed.route_id); if (!route || route.status !== 'active' || store.control(ownerId).state !== 'enabled') { store.finishCandidate(claimed.candidate_id, 'skipped', { reason: 'route-or-control' }); continue; }
        const health = await currentGateway.getHealth(claimed.route_id); const inbound = store.latestInbound(ownerId); if (!health || !['online', 'ok'].includes(health.status) || (inbound && Date.parse(now()) - Date.parse(inbound.occurred_at) < 60 * 60_000)) { store.finishCandidate(claimed.candidate_id, 'skipped', { reason: 'precheck-blocked' }); continue; }
        const profile = service.getProfile(ownerId); const relationship = service.getRelationship(ownerId, claimed.scheduled_at); const decision = service.evaluateProactive({ ownerId, reason: planReason, at: claimed.scheduled_at, requestedBubbles: 1 }); if (!decision.allowed) { store.finishCandidate(claimed.candidate_id, 'skipped', { reason: decision.reason }); continue; }
        const memoryProjection = service.projectProfile({ ownerId, purpose: 'proactive', at: claimed.scheduled_at }); let sources = []; if (claimed.window_kind === 'topic') { if (!currentTopicProvider) { store.finishCandidate(claimed.candidate_id, 'skipped', { reason: 'topic-provider-unavailable' }); continue; } const webProjection = service.projectProfile({ ownerId, purpose: 'web-search', at: claimed.scheduled_at }); const query = rewriteTopicQuery(webProjection); if (!query) { store.finishCandidate(claimed.candidate_id, 'skipped', { reason: 'topic-query-unavailable' }); continue; } const recentUrls = new Set(store.topicSources(ownerId).filter((item) => Date.parse(item.retrieved_at) > Date.parse(now()) - 30 * 86_400_000).map((item) => item.url.toLowerCase())); const ranked = rankTopicResults(await currentTopicProvider.search(query), query, { excludedUrls: recentUrls }); if (!ranked) { store.finishCandidate(claimed.candidate_id, 'skipped', { reason: 'topic-results-weak' }); continue; } const sourceId = store.saveTopicSource({ ownerId, url: ranked.url, title: ranked.title, matchReason: query, score: ranked.score, memoryRefs: webProjection.map((item) => item.memoryId) }); if (!sourceId) { store.finishCandidate(claimed.candidate_id, 'skipped', { reason: 'topic-results-duplicate' }); continue; } sources = [{ title: ranked.title, url: ranked.url, matchReason: query }]; }
        const prompt = buildCompanionPrompt({ profile, relationship, context: planReason, memoryProjection, sources }) + `\n严格只输出 JSON（最多 ${decision.maxBubbles} 条文字气泡）：{"bubbles":[{"text":"..."}],"tone":"warm|playful|opinionated|playful_angry|quiet","stickerIntent":{"emotion":"happy","intensity":1,"context":"${claimed.window_kind === 'topic' ? 'reply' : planReason}","query":"能替代这句话的口语短句"}}。tone 必须从列出的五种值中选择，不要习惯性选择 warm。约三分之一合适的主动消息带一个 stickerIntent；query 要写成你此刻真正想用表情表达的短句，例如“先搞钱咯”“抱抱你”“真的假的”，用于语义检索，不要只写情绪分类。不要每次都发，也不要在严肃倾诉时乱发。stickerIntent 可省略；不要输出 Markdown。`; const generatedOutput = await currentGenerator.generate({ ownerId, routeId: route.routeId, windowKind: claimed.window_kind, prompt, sources, maxBubbles: decision.maxBubbles, scheduledAt: claimed.scheduled_at }); const result = await service.planProactive({ routeId: route.routeId, reason: planReason, scheduledAt: claimed.scheduled_at, expiresAt: claimed.expires_at, generated: generatedOutput, memoryIds: memoryProjection.map((item) => item.memoryId) }); store.finishCandidate(claimed.candidate_id, result.status === 'planned' ? 'planned' : 'skipped', { reason: result.reason, planId: result.planId ?? null }); if (result.status === 'planned') { generated += 1; await runOnce(); }
      } catch (error) { logger.error?.('[dsh-companion] candidate generation failed', error); store.finishCandidate(claimed.candidate_id, 'skipped', { reason: error.code ?? 'generation-failed' }); }
    }
    return { status: 'active', generated };
  }
  async function tick() { if (ticking) return ticking; ticking = tickInternal().finally(() => { ticking = null; }); return ticking; }
  function startWorker({ intervalMs = 60_000 } = {}) { if (workerTimer || !timer?.setInterval) return; workerTimer = timer.setInterval(() => { tick().catch((error) => logger.error?.('[dsh-companion] worker tick failed', error)); }, intervalMs); }
  function stopWorker() { if (workerTimer && timer?.clearInterval) timer.clearInterval(workerTimer); workerTimer = null; }
  const service = {
    attachGateway: attach,
    detachGateway: detach,
    status: () => ({ state, gatewayAttached: Boolean(currentGateway), cursor: clone(store.cursor()) }),
    ownerStatus: (ownerId) => ({ proactive: store.control(ownerId), memory: store.memoryControl(ownerId) }),
    listCandidates: (ownerId, statuses = ['pending','claimed','planned','skipped','expired']) => store.candidates(ownerId, statuses),
    listTopicSources: (ownerId) => store.topicSources(ownerId),
    ensureCandidates,
    ensureFollowUp,
    tick,
    startWorker,
    stopWorker,
    setProviders: ({ generator: nextGenerator, topicProvider: nextTopicProvider, stickerCatalog: nextStickerCatalog, memoryExtractor: nextMemoryExtractor } = {}) => { if (nextGenerator !== undefined) currentGenerator = nextGenerator; if (nextTopicProvider !== undefined) currentTopicProvider = nextTopicProvider; if (nextStickerCatalog !== undefined) currentStickerCatalog = nextStickerCatalog; if (nextMemoryExtractor !== undefined) currentMemoryExtractor = nextMemoryExtractor; },
    remember: (input) => store.remember(input),
    listMemories: ({ ownerId, status, kind, sensitivity } = {}) => { if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('ownerId is required'); if (status && !['active', 'contradicted', 'forgotten'].includes(status)) throw new TypeError('invalid memory status'); if (kind && !['interest', 'dislike', 'person', 'goal', 'preference', 'open_loop', 'routine'].includes(kind)) throw new TypeError('invalid memory kind'); if (sensitivity && !['normal', 'private', 'highly_private'].includes(sensitivity)) throw new TypeError('invalid memory sensitivity'); return store.memories(ownerId, { status, kind, sensitivity }); },
    projectProfile: ({ ownerId, purpose = 'chat', at = now(), limit = 20 } = {}) => { if (typeof ownerId !== 'string' || !ownerId.trim() || !Number.isInteger(limit) || limit < 0 || limit > 100) throw new TypeError('invalid memory projection input'); return store.memories(ownerId).map((row) => projectMemory(row, { purpose, at })).filter(Boolean).slice(0, limit); },
    exportMemories: (ownerId) => { if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('ownerId is required'); return store.exportMemories(ownerId); },
    forgetMemory: async (ownerId, memoryId) => store.forgetMemory(ownerId, memoryId, false),
    eraseMemory: async (ownerId, memoryId) => store.forgetMemory(ownerId, memoryId, true),
    clearMemories: async (ownerId) => ({ ...store.clearMemories(ownerId), boundary: '不会撤回或改写 Harness Session、已发 IM、外部 provider 或备份中的数据' }),
    pauseMemory: async (ownerId) => ({ status: 'paused', ...store.setMemoryState(ownerId, 'paused') }),
    resumeMemory: async (ownerId) => ({ status: 'enabled', ...store.setMemoryState(ownerId, 'enabled') }),
    getProfile: (ownerId) => { store.ensureOwner(ownerId); return store.getProfile(ownerId); },
    updateProfile: (ownerId, patch) => {
      if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('ownerId must be non-empty');
      if (!patch || Object.getPrototypeOf(patch) !== Object.prototype || !Object.keys(patch).length) throw new TypeError('profile patch must be a non-empty plain object');
      const known = ['display_name', 'time_zone', 'interaction_mode', 'daily_budget', 'quiet_hours_start', 'quiet_hours_end']; if (Object.keys(patch).some((key) => !known.includes(key))) throw new TypeError('unknown profile field');
      if (patch?.interaction_mode !== undefined && !['gentle', 'natural', 'clingy'].includes(patch.interaction_mode)) throw new TypeError('invalid interaction mode');
      if (patch?.daily_budget !== undefined && (!Number.isInteger(patch.daily_budget) || patch.daily_budget < 1 || patch.daily_budget > 3)) throw new TypeError('invalid daily budget');
      if (patch?.time_zone !== undefined) { try { new Intl.DateTimeFormat('en-US', { timeZone: patch.time_zone }).format(); } catch { throw new TypeError('invalid time zone'); } }
      if (patch?.display_name !== undefined && patch.display_name !== null && (typeof patch.display_name !== 'string' || !patch.display_name.trim() || patch.display_name.length > 120)) throw new TypeError('invalid display name');
      for (const field of ['quiet_hours_start', 'quiet_hours_end']) if (patch?.[field] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch[field])) throw new TypeError('invalid quiet hour');
      return store.updateProfile(ownerId, patch);
    },
    recordInteraction: (ownerId, feedback, at = now()) => { if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new TypeError('invalid interaction time'); return store.recordInteraction(ownerId, feedback, at); },
    getRelationship: (ownerId, at = now()) => { if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return calculateRelationship({ ownerId, at, timeZone: 'Invalid/TimeZone' }); const since = new Date(Date.parse(at) - 30 * 86_400_000).toISOString(); const profile = service.getProfile(ownerId); return calculateRelationship({ ownerId, at, timeZone: profile?.time_zone, events: store.relationshipEvents(ownerId, since), plans: store.relationshipPlans(ownerId, since) }); },
    evaluateProactive: ({ ownerId, reason, at = now(), requestedBubbles = 1 }) => evaluatePolicy({ profile: service.getProfile(ownerId), relationship: service.getRelationship(ownerId, at), plans: store.plans(ownerId), at, reason, proactiveState: store.control(ownerId).state, requestedBubbles }),
    planProactive: async ({ routeId, reason, scheduledAt, expiresAt, generated, memoryIds = [] }) => {
      if (closed || state !== 'active' || !currentGateway) return { status: 'skipped', reason: 'companion-inactive' };
      const route = currentGateway.getRoute(routeId); if (!route || route.status !== 'active') return { status: 'skipped', reason: 'route-unavailable' };
      if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) return { status: 'skipped', reason: 'invalid-expires-at' };
      const effectiveScheduledAt = scheduledAt ?? now();
      if (typeof effectiveScheduledAt !== 'string' || !Number.isFinite(Date.parse(effectiveScheduledAt)) || Date.parse(expiresAt) <= Date.parse(effectiveScheduledAt)) return { status: 'skipped', reason: 'invalid-date-window' };
        const requestedBubbles = Array.isArray(generated) ? generated.length : generated?.bubbles?.length ?? 1;
        const decision = service.evaluateProactive({ ownerId: route.ownerId, reason, at: scheduledAt ?? now(), requestedBubbles });
      if (!decision.allowed) return { status: 'skipped', reason: decision.reason, decision };
      let normalized; try { normalized = normalizeBubbles(generated, { maxBubbles: decision.maxBubbles, context: generated?.tone }); } catch (error) { return { status: 'skipped', reason: error.code ?? error.message }; }
        const relationship = service.getRelationship(route.ownerId, scheduledAt ?? now());
      if (normalized.tone === 'playful_angry' && !validatePlayfulAngry({ relationship, lastPlanReplied: relationship.lastPlanReplied })) return { status: 'skipped', reason: 'playful-angry-not-eligible' };
      const messages = [...normalized.bubbles];
      if (generated?.stickerIntent && currentStickerCatalog && messages.length < 3) { const caps = await currentGateway.getCapabilities(routeId); const intent = { ...generated.stickerIntent, query: generated.stickerIntent.query ?? normalized.bubbles.map((bubble) => bubble.text).join(' ') }; const selected = currentStickerCatalog.select(intent, { capabilities: caps, recentUsage: store.recentStickerUsage(route.ownerId) }); if (selected) messages.push({ kind: 'sticker', stickerId: selected.id }); }
      let planId; let finalDecision;
        const normalizedScheduledAt = new Date(Date.parse(effectiveScheduledAt)).toISOString();
        const normalizedExpiresAt = new Date(Date.parse(expiresAt)).toISOString();
        try { store.transaction(() => {
        const currentRoute = currentGateway?.getRoute(routeId);
        if (closed || state !== 'active' || !currentGateway || store.cursor().state !== 'active' || !currentRoute || currentRoute.status !== 'active' || currentRoute.routeVersion !== route.routeVersion || currentRoute.inboundVersion !== route.inboundVersion) { finalDecision = { allowed: false, reason: 'route-unavailable' }; return; }
        const refs = memoryIds;
        if (!Array.isArray(refs) || refs.length > 20 || new Set(refs).size !== refs.length || refs.some((id) => typeof id !== 'string' || !id.trim())) { finalDecision = { allowed: false, reason: 'invalid-memory-reference' }; return; }
        const freshProfile = store.getProfile(route.ownerId) ?? service.getProfile(route.ownerId);
        const freshRelationship = service.getRelationship(route.ownerId, scheduledAt ?? now());
        finalDecision = evaluatePolicy({ profile: freshProfile, relationship: freshRelationship, plans: store.plans(route.ownerId), at: scheduledAt ?? now(), reason, proactiveState: store.control(route.ownerId).state, requestedBubbles: normalized.bubbles.length });
        if (normalized.tone === 'playful_angry' && !validatePlayfulAngry({ relationship: freshRelationship, lastPlanReplied: freshRelationship.lastPlanReplied })) { finalDecision = { allowed: false, reason: 'playful-angry-not-eligible' }; return; }
        if (!finalDecision.allowed) return;
          planId = store.queueWithinTransaction({ route, reason, scheduledAt: normalizedScheduledAt, expiresAt: normalizedExpiresAt, messages, memoryIds: refs });
        }); } catch (error) { if (error?.message === 'invalid memory reference') return { status: 'skipped', reason: 'invalid-memory-reference' }; throw error; }
      if (!finalDecision.allowed) return { status: 'skipped', reason: finalDecision.reason, decision: finalDecision };
      return { status: 'planned', planId, decision: finalDecision };
    },
    queuePlan,
    runOnce,
    pause: async (ownerId, reason) => { store.setControl(ownerId, 'paused', reason); store.cancelPlans(ownerId, reason); },
    resume: async (ownerId) => store.setControl(ownerId, 'enabled', 'resume'),
    confirmGatewayResync: async ({ ownerId, proactiveState }) => {
      if (!currentGateway || !['enabled', 'paused'].includes(proactiveState)) throw new TypeError('explicit proactiveState is required');
      const cursor = currentGateway.getJournalState().currentCursor;
      store.setCursor(cursor, 'active'); store.setControl(ownerId, proactiveState, 'resync-confirmed'); state = 'active';
    },
    inspectPlan: (planId) => store.inspect(planId),
    drain: async () => { await attaching; await Promise.allSettled([...activeRuns]); },
    close: async () => { if (closed) return; closed = true; stopWorker(); await detach(); await Promise.allSettled([...activeRuns]); store.close(); },
  };
  if (gateway) await attach(gateway);
  return service;
}
