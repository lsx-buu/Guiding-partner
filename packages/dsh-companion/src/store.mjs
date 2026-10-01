import { randomUUID, createHash } from 'node:crypto';
import { normalizeMemory } from './memory.mjs';

const nowIso = () => new Date().toISOString();

export class CompanionStore {
  constructor(db, now = nowIso) { this.db = db; this.now = now; }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE;'); try { const value = fn(); this.db.exec('COMMIT;'); return value; } catch (error) { this.db.exec('ROLLBACK;'); throw error; } }
  ensureOwner(ownerId) {
    const now = this.now();
    this.db.prepare(`INSERT INTO profiles(owner_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO NOTHING`).run(ownerId, now, now);
    this.db.prepare(`INSERT INTO owner_controls(owner_id, state, updated_at) VALUES (?, 'enabled', ?) ON CONFLICT(owner_id) DO NOTHING`).run(ownerId, now);
    this.db.prepare(`UPDATE profiles SET time_zone='Asia/Shanghai', quiet_hours_start='00:00', quiet_hours_end='07:00' WHERE owner_id=? AND (time_zone IS NULL OR quiet_hours_start IS NULL OR quiet_hours_end IS NULL)`).run(ownerId);
  }
  control(ownerId) { return this.db.prepare('SELECT * FROM owner_controls WHERE owner_id=?').get(ownerId) ?? { owner_id: ownerId, state: 'enabled' }; }
  getProfile(ownerId) { return this.db.prepare('SELECT * FROM profiles WHERE owner_id=?').get(ownerId) ?? null; }
  memoryControl(ownerId) { this.ensureOwner(ownerId); return this.db.prepare('SELECT memory_state,version FROM owner_controls WHERE owner_id=?').get(ownerId); }
  remember(input) {
    const memory = normalizeMemory(input, { now: this.now() }); this.ensureOwner(memory.owner_id);
    return this.transaction(() => {
      if (this.memoryControl(memory.owner_id).memory_state !== 'enabled') return { status: 'skipped', reason: 'memory-paused' };
      const existing = this.db.prepare('SELECT * FROM memories WHERE owner_id=? AND fingerprint=?').get(memory.owner_id, memory.fingerprint);
      if (existing?.status === 'forgotten') return { status: 'skipped', reason: 'memory-forgotten', memoryId: existing.memory_id };
      if (existing) { const sensitivity = Math.max(['normal', 'private', 'highly_private'].indexOf(existing.sensitivity), ['normal', 'private', 'highly_private'].indexOf(memory.sensitivity)); this.db.prepare('UPDATE memories SET confidence=MAX(confidence,?),sensitivity=?,last_confirmed_at=?,expires_at=?,evidence_session_id=COALESCE(?,evidence_session_id),evidence_event_id=COALESCE(?,evidence_event_id),status=\'active\',updated_at=? WHERE memory_id=?').run(memory.confidence, ['normal', 'private', 'highly_private'][sensitivity], memory.last_confirmed_at, memory.expires_at, memory.evidence_session_id, memory.evidence_event_id, this.now(), existing.memory_id); return { status: 'confirmed', memoryId: existing.memory_id }; }
      this.db.prepare(`INSERT INTO memories(memory_id,owner_id,kind,summary,evidence_session_id,evidence_event_id,confidence,sensitivity,last_confirmed_at,expires_at,status,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(memory.memory_id, memory.owner_id, memory.kind, memory.summary, memory.evidence_session_id, memory.evidence_event_id, memory.confidence, memory.sensitivity, memory.last_confirmed_at, memory.expires_at, 'active', memory.fingerprint, memory.created_at, memory.updated_at);
      return { status: 'created', memoryId: memory.memory_id };
    });
  }
  memories(ownerId, { status, kind, sensitivity } = {}) { const clauses = ['owner_id=?']; const args = [ownerId]; if (status) { clauses.push('status=?'); args.push(status); } if (kind) { clauses.push('kind=?'); args.push(kind); } if (sensitivity) { clauses.push('sensitivity=?'); args.push(sensitivity); } return this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`).all(...args); }
  exportMemories(ownerId) { return this.memories(ownerId).map(({ evidence_event_id, evidence_session_id, fingerprint, ...safe }) => safe); }
  setMemoryState(ownerId, state) { if (!['enabled', 'paused'].includes(state)) throw new TypeError('invalid memory state'); this.ensureOwner(ownerId); return this.transaction(() => { this.db.prepare('UPDATE owner_controls SET memory_state=?,version=version+1,updated_at=? WHERE owner_id=?').run(state, this.now(), ownerId); if (state === 'paused') for (const row of this.memories(ownerId, { status: 'active' })) this.cancelMemoryPlans(ownerId, row.memory_id); return this.memoryControl(ownerId); }); }
  cancelMemoryPlans(ownerId, memoryId) { const plans = this.db.prepare(`SELECT plan_id FROM proactive_plans WHERE owner_id=? AND status IN ('planned','claimed','sending') AND EXISTS (SELECT 1 FROM json_each(proactive_plans.memory_refs_json) WHERE value=?)`).all(ownerId, memoryId); for (const plan of plans) { const sent = this.db.prepare("SELECT COUNT(*) AS n FROM plan_messages WHERE plan_id=? AND status='sent'").get(plan.plan_id).n; this.db.prepare("UPDATE proactive_plans SET status=?,updated_at=? WHERE plan_id=?").run(sent ? 'sent' : 'cancelled', this.now(), plan.plan_id); this.db.prepare("UPDATE plan_messages SET status='cancelled',updated_at=? WHERE plan_id=? AND status IN ('pending','sending')").run(this.now(), plan.plan_id); } return plans.length; }
  forgetMemory(ownerId, memoryId, erase = false) { this.ensureOwner(ownerId); return this.transaction(() => { const exists = this.db.prepare('SELECT memory_id FROM memories WHERE owner_id=? AND memory_id=?').get(ownerId, memoryId); if (!exists) return { status: 'not-found', affectedPlans: 0 }; const affectedPlans = this.cancelMemoryPlans(ownerId, memoryId); const deletedTopicSources = this.deleteTopicSourcesForMemory(ownerId, memoryId); if (erase) this.db.prepare('DELETE FROM memories WHERE owner_id=? AND memory_id=?').run(ownerId, memoryId); else this.db.prepare("UPDATE memories SET status='forgotten',summary='[forgotten]',evidence_session_id=NULL,evidence_event_id=NULL,updated_at=? WHERE owner_id=? AND memory_id=?").run(this.now(), ownerId, memoryId); return { status: erase ? 'erased' : 'forgotten', affectedPlans, deletedTopicSources }; }); }
  clearMemories(ownerId) { this.ensureOwner(ownerId); return this.transaction(() => { const ids = this.db.prepare('SELECT memory_id FROM memories WHERE owner_id=?').all(ownerId); let affectedPlans = 0; for (const row of ids) affectedPlans += this.cancelMemoryPlans(ownerId, row.memory_id); this.db.prepare('DELETE FROM topic_sources WHERE owner_id=?').run(ownerId); this.db.prepare('DELETE FROM memories WHERE owner_id=?').run(ownerId); return { deleted: ids.length, affectedPlans }; }); }
  updateProfile(ownerId, patch) {
    this.ensureOwner(ownerId); const allowed = ['display_name', 'time_zone', 'interaction_mode', 'daily_budget', 'quiet_hours_start', 'quiet_hours_end'];
    const entries = Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key));
    if (!entries.length) return this.getProfile(ownerId);
    const fields = entries.map(([key]) => `${key}=?`).join(', '); this.db.prepare(`UPDATE profiles SET ${fields},updated_at=? WHERE owner_id=?`).run(...entries.map(([, value]) => value), this.now(), ownerId); return this.getProfile(ownerId);
  }
  setControl(ownerId, state, reason) { this.ensureOwner(ownerId); this.db.prepare('UPDATE owner_controls SET state=?, reason=?, updated_at=? WHERE owner_id=?').run(state, reason ?? null, this.now(), ownerId); }
  cursor() { return this.db.prepare('SELECT * FROM gateway_cursors WHERE name=?').get('gateway') ?? { name: 'gateway', cursor: '0', state: 'active' }; }
  advanceCursor(cursor, state = 'active') {
    const next = Number(cursor); const current = Number(this.cursor().cursor);
    const row = this.cursor();
    if (!Number.isSafeInteger(next) || next < current) return false;
    if (next === current && state === row.state) return false;
    this.db.prepare(`INSERT INTO gateway_cursors(name,cursor,state,updated_at) VALUES('gateway',?,?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,state=excluded.state,updated_at=excluded.updated_at`).run(String(next), state, this.now());
    return true;
  }
  setCursor(cursor, state = 'active') { this.advanceCursor(cursor, state); }
  rebaseCursorAfterGatewayRestart(cursor = '0') {
    const next = Number(cursor);
    if (!Number.isSafeInteger(next) || next < 0) throw new TypeError('invalid gateway restart cursor');
    this.db.prepare(`INSERT INTO gateway_cursors(name,cursor,state,updated_at) VALUES('gateway',?,'active',?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,state='active',updated_at=excluded.updated_at`).run(String(next), this.now());
    return this.cursor();
  }
  route(route) {
    const now = this.now();
    this.ensureOwner(route.ownerId);
    this.db.prepare(`INSERT INTO companion_routes(route_id,owner_id,channel,bot_id,conversation_id,route_version,inbound_version,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(route_id) DO UPDATE SET owner_id=excluded.owner_id,route_version=excluded.route_version,inbound_version=excluded.inbound_version,status=excluded.status,updated_at=excluded.updated_at`).run(route.routeId, route.ownerId, route.channel, route.botId, route.conversationId, route.routeVersion, route.inboundVersion, route.status, now);
  }
  addEvent(event, ownerId) {
    this.ensureOwner(ownerId);
    const result = this.db.prepare(`INSERT OR IGNORE INTO interaction_events(event_id,owner_id,route_id,kind,occurred_at,inbound_version,control_intent) VALUES(?,?,?,?,?,?,?)`).run(event.event_id, ownerId, event.routeId, 'inbound', event.occurredAt, event.inboundVersion ?? null, event.controlIntent ?? null);
    return Number(result.changes) > 0;
  }
  recordInbound(event, ownerId) {
    this.ensureOwner(ownerId);
    const eventId = event.event_id; const occurred = Date.parse(event.occurredAt); const sixHours = 6 * 60 * 60 * 1000;
    const candidate = Number.isFinite(occurred) ? this.db.prepare(`SELECT p.plan_id, MAX(m.updated_at) AS sent_at FROM proactive_plans p JOIN plan_messages m ON m.plan_id=p.plan_id WHERE p.owner_id=? AND p.status IN ('sent','delivery_unknown','sending') AND m.status='sent' AND NOT EXISTS (SELECT 1 FROM interaction_events prior WHERE prior.plan_id=p.plan_id AND prior.kind='reply') GROUP BY p.plan_id ORDER BY sent_at DESC LIMIT 1`).get(ownerId) : null;
    const candidateMs = candidate ? Date.parse(candidate.sent_at) : NaN;
    const planId = candidate && Number.isFinite(candidateMs) && occurred >= candidateMs && occurred - candidateMs <= sixHours ? candidate.plan_id : null;
    const kind = planId ? 'reply' : 'user_initiated';
    const result = this.db.prepare(`INSERT OR IGNORE INTO interaction_events(event_id,owner_id,route_id,kind,occurred_at,inbound_version,control_intent,plan_id,feedback) VALUES(?,?,?,?,?,?,?,?,?)`).run(eventId, ownerId, event.routeId, kind, event.occurredAt, event.inboundVersion ?? null, event.controlIntent ?? null, planId, null);
    return { inserted: Number(result.changes) > 0, planId, kind };
  }
  recordInteraction(ownerId, feedback, at = this.now()) {
    if (!['explicit_positive', 'explicit_negative'].includes(feedback)) throw new TypeError('feedback must be explicit_positive or explicit_negative');
    this.ensureOwner(ownerId); const id = `feedback:${ownerId}:${at}:${randomUUID()}`; this.db.prepare(`INSERT INTO interaction_events(event_id,owner_id,route_id,kind,occurred_at,feedback) VALUES(?,?,?,?,?,?)`).run(id, ownerId, 'profile', 'feedback', at, feedback); return id;
  }
  relationshipEvents(ownerId, since) { return this.db.prepare('SELECT * FROM interaction_events WHERE owner_id=? AND occurred_at>=? ORDER BY occurred_at').all(ownerId, since); }
  relationshipPlans(ownerId, since) { return this.db.prepare(`SELECT p.plan_id,p.owner_id,MAX(m.updated_at) AS sent_at,1 AS sent FROM proactive_plans p JOIN plan_messages m ON m.plan_id=p.plan_id AND m.status='sent' WHERE p.owner_id=? AND p.status='sent' AND m.updated_at>=? GROUP BY p.plan_id`).all(ownerId, since); }
  latestSentPlan(ownerId) { return this.db.prepare("SELECT p.plan_id,p.route_id,p.reason,MAX(m.updated_at) AS sent_at FROM proactive_plans p JOIN plan_messages m ON m.plan_id=p.plan_id AND m.status='sent' WHERE p.owner_id=? AND p.status='sent' GROUP BY p.plan_id ORDER BY sent_at DESC LIMIT 1").get(ownerId) ?? null; }
  planHasReply(planId) { return Boolean(this.db.prepare("SELECT 1 FROM interaction_events WHERE plan_id=? AND kind='reply' LIMIT 1").get(planId)); }
  replyLatencies(ownerId, since) { return this.db.prepare("SELECT (julianday(e.occurred_at)-julianday(s.sent_at))*86400000 AS latency_ms FROM interaction_events e JOIN (SELECT p.plan_id,MAX(m.updated_at) AS sent_at FROM proactive_plans p JOIN plan_messages m ON m.plan_id=p.plan_id AND m.status='sent' WHERE p.owner_id=? GROUP BY p.plan_id) s ON s.plan_id=e.plan_id WHERE e.kind='reply' AND e.occurred_at>=? AND julianday(e.occurred_at)>=julianday(s.sent_at) AND (julianday(e.occurred_at)-julianday(s.sent_at))*86400000<=21600000 ORDER BY latency_ms").all(ownerId, since).map((row) => Number(row.latency_ms)).filter(Number.isFinite); }
  plans(ownerId) { return this.db.prepare(`SELECT p.*, EXISTS (SELECT 1 FROM delivery_attempts a JOIN plan_messages m ON m.message_id=a.message_id WHERE m.plan_id=p.plan_id) AS has_attempt FROM proactive_plans p WHERE p.owner_id=? ORDER BY p.created_at`).all(ownerId); }
  upsertCandidate(candidate) { const now = this.now(); this.db.prepare(`INSERT INTO proactive_candidates(candidate_id,owner_id,route_id,local_date,window_kind,status,scheduled_at,expires_at,lease_owner,lease_until,decision_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?) ON CONFLICT(owner_id,local_date,window_kind) DO NOTHING`).run(candidate.candidateId, candidate.ownerId, candidate.routeId ?? null, candidate.localDate, candidate.windowKind, 'pending', candidate.scheduledAt, candidate.expiresAt, now, now); return this.db.prepare('SELECT * FROM proactive_candidates WHERE owner_id=? AND local_date=? AND window_kind=?').get(candidate.ownerId, candidate.localDate, candidate.windowKind); }
  candidates(ownerId, statuses = ['pending']) { const qs = statuses.map(() => '?').join(','); return this.db.prepare(`SELECT * FROM proactive_candidates WHERE owner_id=? AND status IN (${qs}) ORDER BY scheduled_at`).all(ownerId, ...statuses); }
  latestInbound(ownerId) { return this.db.prepare("SELECT occurred_at FROM interaction_events WHERE owner_id=? AND kind IN ('inbound','user_initiated','reply') ORDER BY occurred_at DESC LIMIT 1").get(ownerId) ?? null; }
  topicSources(ownerId) { return this.db.prepare('SELECT * FROM topic_sources WHERE owner_id=? ORDER BY retrieved_at DESC').all(ownerId); }
  saveTopicSource({ ownerId, url, title, matchReason = '', score = 0, memoryRefs = [] }) { const fingerprint = createHash('sha256').update(`${url}\0${title}`).digest('hex'); const threshold = new Date(Date.parse(this.now()) - 30 * 86_400_000).toISOString(); const recent = this.db.prepare('SELECT source_id FROM topic_sources WHERE owner_id=? AND (fingerprint=? OR lower(url)=lower(?)) AND retrieved_at>?').get(ownerId, fingerprint, url, threshold); if (recent) return null; const sourceId = randomUUID(); this.db.prepare('INSERT OR IGNORE INTO topic_sources(source_id,owner_id,fingerprint,url,title,retrieved_at,match_reason,score,last_used_at,memory_refs_json) VALUES(?,?,?,?,?,?,?,?,NULL,?)').run(sourceId, ownerId, fingerprint, url, title, this.now(), matchReason, score, JSON.stringify(memoryRefs)); return sourceId; }
  deleteTopicSourcesForMemory(ownerId, memoryId) { return Number(this.db.prepare("DELETE FROM topic_sources WHERE owner_id=? AND EXISTS (SELECT 1 FROM json_each(topic_sources.memory_refs_json) WHERE value=?)").run(ownerId, memoryId).changes); }
  recentStickerUsage(ownerId) { return new Map(this.db.prepare('SELECT sticker_id,MAX(used_at) AS used_at FROM sticker_usage WHERE owner_id=? GROUP BY sticker_id').all(ownerId).map((row) => [row.sticker_id, row.used_at])); }
  recordStickerUsage(ownerId, stickerId) { this.ensureOwner(ownerId); this.db.prepare('INSERT INTO sticker_usage(usage_id,owner_id,sticker_id,used_at) VALUES(?,?,?,?)').run(randomUUID(), ownerId, stickerId, this.now()); }
  claimCandidate(candidateId, workerId) { return this.transaction(() => { const row = this.db.prepare("SELECT * FROM proactive_candidates WHERE candidate_id=? AND status='pending'").get(candidateId); if (!row) return null; this.db.prepare("UPDATE proactive_candidates SET status='claimed',lease_owner=?,lease_until=?,updated_at=? WHERE candidate_id=? AND status='pending'").run(workerId, new Date(Date.parse(this.now()) + 30_000).toISOString(), this.now(), candidateId); return this.db.prepare('SELECT * FROM proactive_candidates WHERE candidate_id=?').get(candidateId); }); }
  recoverCandidates(at = this.now()) { this.db.prepare("UPDATE proactive_candidates SET status='pending',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='claimed' AND lease_until<=?").run(at, at); this.db.prepare("UPDATE proactive_candidates SET status='expired',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status IN ('pending','claimed') AND expires_at<=?").run(at, at); }
  finishCandidate(candidateId, status, decision) { this.db.prepare('UPDATE proactive_candidates SET status=?,lease_owner=NULL,lease_until=NULL,decision_json=?,updated_at=? WHERE candidate_id=?').run(status, JSON.stringify(decision ?? null), this.now(), candidateId); }
  cancelFollowUpCandidates(ownerId, reason = 'inbound') { this.db.prepare("UPDATE proactive_candidates SET status='skipped',lease_owner=NULL,lease_until=NULL,decision_json=?,updated_at=? WHERE owner_id=? AND window_kind='follow_up' AND status IN ('pending','claimed')").run(JSON.stringify({ reason }), this.now(), ownerId); }
  cancelPlans(ownerId, reason = 'inbound') {
    this.db.prepare(`UPDATE proactive_plans SET status=CASE WHEN EXISTS (SELECT 1 FROM plan_messages m WHERE m.plan_id=proactive_plans.plan_id AND m.status='sent') THEN 'sent' ELSE 'cancelled' END,updated_at=? WHERE owner_id=? AND status IN ('planned','claimed')`).run(this.now(), ownerId);
    this.db.prepare(`UPDATE plan_messages SET status='cancelled',updated_at=? WHERE plan_id IN (SELECT plan_id FROM proactive_plans WHERE owner_id=?) AND status='pending'`).run(this.now(), ownerId);
  }
  queue({ route, reason, scheduledAt, expiresAt, messages, memoryIds = [] }) {
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 3) throw new TypeError('messages must contain 1 to 3 items');
    if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('reason must be non-empty');
    for (const message of messages) {
      if (!message || Object.getPrototypeOf(message) !== Object.prototype || (message.kind === 'text' && (typeof message.text !== 'string' || !message.text.trim())) || (message.kind === 'sticker' && (typeof message.stickerId !== 'string' || !message.stickerId.trim())) || !['text', 'sticker'].includes(message.kind)) throw new TypeError('invalid message');
      if (message.delayMs !== undefined && (!Number.isFinite(message.delayMs) || message.delayMs < 0)) throw new TypeError('delayMs must be non-negative and finite');
      const keys = Object.keys(message); if (keys.some((key) => !['kind', 'text', 'stickerId', 'delayMs'].includes(key))) throw new TypeError('unsupported message field');
    }
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) throw new TypeError('expiresAt must be an ISO date');
    if (scheduledAt !== undefined && (typeof scheduledAt !== 'string' || Number.isNaN(Date.parse(scheduledAt)))) throw new TypeError('scheduledAt must be an ISO date');
    const now = this.now();
    const normalizedScheduledAt = scheduledAt === undefined ? now : new Date(Date.parse(scheduledAt)).toISOString();
    const normalizedExpiresAt = new Date(Date.parse(expiresAt)).toISOString();
    return this.transaction(() => this.queueWithinTransaction({ route, reason, scheduledAt: normalizedScheduledAt, expiresAt: normalizedExpiresAt, messages, memoryIds }));
  }
  queueWithinTransaction({ route, reason, scheduledAt, expiresAt, messages, memoryIds = [] }) {
    const planId = randomUUID(); const now = this.now();
    this.ensureOwner(route.ownerId);
      if (!Array.isArray(memoryIds) || memoryIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(memoryIds).size !== memoryIds.length) throw new TypeError('invalid memory references');
      if (memoryIds.length && (this.memoryControl(route.ownerId).memory_state !== 'enabled' || memoryIds.some((id) => !this.db.prepare("SELECT memory_id FROM memories WHERE owner_id=? AND memory_id=? AND status='active' AND expires_at>?").get(route.ownerId, id, scheduledAt)))) throw new TypeError('invalid memory reference');
      this.db.prepare(`INSERT INTO proactive_plans(plan_id,owner_id,route_id,reason,scheduled_at,expires_at,route_version,inbound_version,status,lease_owner,lease_until,created_at,updated_at,memory_refs_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(planId, route.ownerId, route.routeId, reason.trim(), scheduledAt, expiresAt, route.routeVersion, route.inboundVersion, 'planned', null, null, now, now, JSON.stringify(memoryIds));
      const stmt = this.db.prepare(`INSERT INTO plan_messages(message_id,plan_id,position,idempotency_key,content_json,status,delivery_json,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
      messages.forEach((content, index) => stmt.run(randomUUID(), planId, index, `${planId}:${index}`, JSON.stringify(content.kind === 'sticker' ? { kind: 'sticker', stickerId: content.stickerId } : { kind: 'text', text: content.text.trim(), ...(content.delayMs === undefined ? {} : { delayMs: content.delayMs }) }), 'pending', null, now));
    return planId;
  }
  claim(workerId, now = this.now()) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM proactive_plans WHERE status='planned' AND (scheduled_at IS NULL OR scheduled_at<=?) AND (retry_scheduled_at IS NULL OR retry_scheduled_at<=?) AND expires_at>? ORDER BY COALESCE(retry_scheduled_at,scheduled_at),created_at LIMIT 1`).get(now, now, now);
      if (!row) return null;
      const leaseUntil = new Date(new Date(now).getTime() + 30_000).toISOString();
      this.db.prepare(`UPDATE proactive_plans SET status='claimed',lease_owner=?,lease_until=?,updated_at=? WHERE plan_id=? AND status='planned'`).run(workerId, leaseUntil, now, row.plan_id);
      return this.db.prepare('SELECT * FROM proactive_plans WHERE plan_id=?').get(row.plan_id);
    });
  }
  messages(planId) { return this.db.prepare('SELECT * FROM plan_messages WHERE plan_id=? ORDER BY position').all(planId); }
  markSending(messageId, planId, attemptId, key) { this.transaction(() => { this.db.prepare(`UPDATE proactive_plans SET status='sending',updated_at=? WHERE plan_id=? AND status='claimed'`).run(this.now(), planId); this.db.prepare(`UPDATE plan_messages SET status='sending',updated_at=? WHERE message_id=?`).run(this.now(), messageId); this.db.prepare(`INSERT INTO delivery_attempts(attempt_id,message_id,idempotency_key,started_at) VALUES(?,?,?,?)`).run(attemptId, messageId, key, this.now()); }); }
  finish(messageId, planId, outcome, receipt) {
    this.transaction(() => {
      const messageStatus = outcome === 'sent' ? 'sent' : outcome === 'unknown' ? 'delivery_unknown' : outcome === 'cancelled' ? 'cancelled' : 'failed_final';
      this.db.prepare(`UPDATE plan_messages SET status=?,delivery_json=?,updated_at=? WHERE message_id=?`).run(messageStatus, JSON.stringify(receipt ?? null), this.now(), messageId);
      this.db.prepare(`UPDATE delivery_attempts SET finished_at=?,outcome=?,receipt_json=? WHERE message_id=? AND finished_at IS NULL`).run(this.now(), outcome, JSON.stringify(receipt ?? null), messageId);
      if (outcome !== 'sent') this.db.prepare(`UPDATE plan_messages SET status='cancelled',updated_at=? WHERE plan_id=? AND status='pending'`).run(this.now(), planId);
      const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM plan_messages WHERE plan_id=? AND status IN ('pending','sending')`).get(planId).count;
      if (!pending) {
        this.db.prepare(`UPDATE proactive_plans SET status=?,retry_scheduled_at=NULL,updated_at=? WHERE plan_id=?`).run(outcome === 'unknown' ? 'delivery_unknown' : outcome === 'cancelled' ? 'cancelled' : outcome === 'failed_final' ? 'failed_final' : 'sent', this.now(), planId);
      }
    });
  }
  deferRateLimit(messageId, planId, retryAt, receipt) { this.transaction(() => { this.db.prepare("UPDATE plan_messages SET status='pending',delivery_json=?,updated_at=? WHERE message_id=? AND status='sending'").run(JSON.stringify(receipt ?? null), this.now(), messageId); this.db.prepare("UPDATE delivery_attempts SET finished_at=?,outcome='rate_limited',receipt_json=? WHERE message_id=? AND finished_at IS NULL").run(this.now(), JSON.stringify(receipt ?? null), messageId); this.db.prepare("UPDATE proactive_plans SET status='planned',lease_owner=NULL,lease_until=NULL,retry_scheduled_at=?,retry_count=retry_count+1,updated_at=? WHERE plan_id=?").run(retryAt, this.now(), planId); }); }
  skipMessage(messageId, planId, reason) { this.transaction(() => { this.db.prepare("UPDATE plan_messages SET status='cancelled',delivery_json=?,updated_at=? WHERE message_id=? AND status='pending'").run(JSON.stringify({ reason }), this.now(), messageId); this.settlePlan(planId); }); }
  settlePlan(planId) { const rows = this.messages(planId); if (rows.some((row) => ['pending','sending'].includes(row.status))) return null; const status = rows.some((row) => row.status === 'delivery_unknown') ? 'delivery_unknown' : rows.some((row) => row.status === 'failed_final') ? 'failed_final' : rows.some((row) => row.status === 'sent') ? 'sent' : 'cancelled'; this.db.prepare('UPDATE proactive_plans SET status=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE plan_id=?').run(status, this.now(), planId); return status; }
  cancelRemaining(planId) { this.db.prepare(`UPDATE plan_messages SET status='cancelled',updated_at=? WHERE plan_id=? AND status='pending'`).run(this.now(), planId); }
  cancelPlan(planId, reason = 'cancelled') { const sent = this.db.prepare(`SELECT COUNT(*) AS count FROM plan_messages WHERE plan_id=? AND status='sent'`).get(planId).count; this.db.prepare(`UPDATE proactive_plans SET status=?,updated_at=? WHERE plan_id=?`).run(sent ? 'sent' : 'cancelled', this.now(), planId); this.cancelRemaining(planId); }
  inspect(planId) { const plan = this.db.prepare('SELECT * FROM proactive_plans WHERE plan_id=?').get(planId); if (!plan) return null; return { ...plan, messages: this.messages(planId).map((message) => ({ ...message, content: JSON.parse(message.content_json), content_json: undefined })) }; }
  recover(now = this.now()) {
    this.transaction(() => {
      this.db.prepare(`UPDATE plan_messages SET status='delivery_unknown',updated_at=? WHERE status='sending'`).run(now);
      this.db.prepare(`UPDATE proactive_plans SET status='delivery_unknown',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE plan_id IN (SELECT plan_id FROM plan_messages WHERE status='delivery_unknown')`).run(now);
      this.db.prepare(`UPDATE proactive_plans SET status='expired',updated_at=? WHERE status IN ('planned','claimed') AND expires_at<=?`).run(now, now);
      this.db.prepare(`UPDATE proactive_plans SET status='planned',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='claimed' AND expires_at>? AND NOT EXISTS (SELECT 1 FROM delivery_attempts a JOIN plan_messages m ON m.message_id=a.message_id WHERE m.plan_id=proactive_plans.plan_id)`).run(now, now);
    });
  }
  close() { this.db.close(); }
}
