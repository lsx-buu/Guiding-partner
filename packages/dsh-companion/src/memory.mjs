import { createHash, randomUUID } from 'node:crypto';

export const MEMORY_KINDS = ['interest', 'dislike', 'person', 'goal', 'preference', 'open_loop', 'routine'];
export const SENSITIVITIES = ['normal', 'private', 'highly_private'];

export function normalizeMemory(input, { now = new Date().toISOString() } = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('memory must be a plain object');
  const keys = Object.keys(input); const allowed = ['memory_id','owner_id','kind','summary','evidence_session_id','evidence_event_id','confidence','sensitivity','last_confirmed_at','expires_at'];
  if (keys.some((key) => !allowed.includes(key))) throw new TypeError('unknown memory field');
  if (typeof input.owner_id !== 'string' || !input.owner_id.trim()) throw new TypeError('memory owner is required');
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw new TypeError('invalid now');
  const summary = typeof input.summary === 'string' ? input.summary.trim().replace(/\s+/g, ' ') : '';
  if (!summary || summary.length > 500) throw new TypeError('memory summary must be 1-500 characters');
  if (!MEMORY_KINDS.includes(input.kind)) throw new TypeError('invalid memory kind');
  if (!SENSITIVITIES.includes(input.sensitivity ?? 'normal')) throw new TypeError('invalid memory sensitivity');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new TypeError('confidence must be 0..1');
  for (const field of ['evidence_event_id','evidence_session_id']) if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field].trim())) throw new TypeError('evidence ids must be non-empty strings');
  if (!(input.evidence_event_id || input.evidence_session_id)) throw new TypeError('memory requires evidence');
  if (input.memory_id !== undefined && (typeof input.memory_id !== 'string' || !input.memory_id.trim() || input.memory_id.length > 200)) throw new TypeError('invalid memory id');
  if (typeof input.last_confirmed_at !== 'undefined' && (typeof input.last_confirmed_at !== 'string' || !Number.isFinite(Date.parse(input.last_confirmed_at)))) throw new TypeError('invalid last_confirmed_at');
  if (typeof input.expires_at !== 'string' || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= Date.parse(now)) throw new TypeError('memory expiry must be in the future');
  if (input.last_confirmed_at && Date.parse(input.last_confirmed_at) > Date.parse(now)) throw new TypeError('last_confirmed_at cannot be in the future');
  const fingerprint = createHash('sha256').update(`${input.owner_id.trim()}\0${input.kind}\0${summary}`).digest('hex');
  return { memory_id: input.memory_id ?? randomUUID(), owner_id: input.owner_id.trim(), kind: input.kind, summary, evidence_session_id: input.evidence_session_id?.trim() ?? null, evidence_event_id: input.evidence_event_id?.trim() ?? null, confidence: input.confidence, sensitivity: input.sensitivity ?? 'normal', last_confirmed_at: input.last_confirmed_at ?? now, expires_at: new Date(Date.parse(input.expires_at)).toISOString(), status: 'active', fingerprint, created_at: input.created_at ?? now, updated_at: now };
}

export function projectMemory(row, { purpose = 'chat', at = new Date().toISOString() } = {}) {
  if (!['chat', 'proactive', 'web-search'].includes(purpose)) throw new TypeError('invalid memory projection purpose');
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new TypeError('invalid projection time');
  if (!row || row.status !== 'active' || !['normal', 'private', 'highly_private'].includes(row.sensitivity) || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.parse(at)) return null;
  if (purpose === 'proactive' && row.sensitivity === 'highly_private') return null;
  if (purpose === 'web-search' && row.sensitivity !== 'normal') return null;
  if (purpose === 'web-search') return { memoryId: row.memory_id, kind: row.kind, summary: row.summary };
  return { memoryId: row.memory_id, kind: row.kind, summary: row.summary, sensitivity: row.sensitivity, confidence: row.confidence };
}
