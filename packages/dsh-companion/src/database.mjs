import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (
  owner_id TEXT PRIMARY KEY, display_name TEXT, time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai', interaction_mode TEXT NOT NULL DEFAULT 'natural',
  daily_budget INTEGER NOT NULL DEFAULT 3, quiet_hours_start TEXT NOT NULL DEFAULT '00:00', quiet_hours_end TEXT NOT NULL DEFAULT '07:00', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companion_routes (
  route_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, channel TEXT NOT NULL, bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, route_version INTEGER NOT NULL, inbound_version INTEGER NOT NULL,
  status TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interaction_events (
  event_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, route_id TEXT NOT NULL, kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL, inbound_version INTEGER, control_intent TEXT, plan_id TEXT, feedback TEXT
);
CREATE TABLE IF NOT EXISTS proactive_plans (
  plan_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, route_id TEXT NOT NULL, reason TEXT NOT NULL,
  scheduled_at TEXT, expires_at TEXT NOT NULL, route_version INTEGER NOT NULL, inbound_version INTEGER NOT NULL,
  status TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, retry_scheduled_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, memory_refs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('interest','dislike','person','goal','preference','open_loop','routine')),
  summary TEXT NOT NULL, evidence_session_id TEXT, evidence_event_id TEXT, confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal','private','highly_private')), last_confirmed_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','contradicted','forgotten')), fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS proactive_candidates (
  candidate_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, route_id TEXT, local_date TEXT NOT NULL, window_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','planned','skipped','expired')), scheduled_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  lease_owner TEXT, lease_until TEXT, decision_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_id, local_date, window_kind)
);
CREATE TABLE IF NOT EXISTS topic_sources (source_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fingerprint TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, retrieved_at TEXT NOT NULL, match_reason TEXT, score REAL NOT NULL, last_used_at TEXT, memory_refs_json TEXT NOT NULL DEFAULT '[]', UNIQUE(owner_id, fingerprint));
CREATE TABLE IF NOT EXISTS sticker_usage (usage_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, sticker_id TEXT NOT NULL, used_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plan_messages (
  message_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES proactive_plans(plan_id) ON DELETE CASCADE,
  position INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, content_json TEXT NOT NULL,
  status TEXT NOT NULL, delivery_json TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  attempt_id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES plan_messages(message_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, receipt_json TEXT
);
CREATE TABLE IF NOT EXISTS owner_controls (
  owner_id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT, memory_state TEXT NOT NULL DEFAULT 'enabled', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_cursors (
  name TEXT PRIMARY KEY, cursor TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interaction_owner_time ON interaction_events(owner_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_plans_owner_time ON proactive_plans(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_owner_status ON memories(owner_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_owner_kind ON memories(owner_id, kind);
CREATE INDEX IF NOT EXISTS idx_candidates_due ON proactive_candidates(status, scheduled_at);
`;

export async function openCompanionDatabase(databasePath) {
  if (databasePath !== ':memory:') await mkdir(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(SCHEMA);
    db.exec(`INSERT OR IGNORE INTO gateway_cursors(name, cursor, state, updated_at) VALUES ('gateway', '0', 'active', '${new Date().toISOString()}')`);
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    if (!row) db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(SCHEMA_VERSION);
    else if (row.version > SCHEMA_VERSION) throw new Error(`Unsupported companion schema version: ${row.version}`);
    else if (row.version < 2) {
      db.exec("ALTER TABLE profiles ADD COLUMN quiet_hours_start TEXT NOT NULL DEFAULT '00:00'; ALTER TABLE profiles ADD COLUMN quiet_hours_end TEXT NOT NULL DEFAULT '07:00'; ALTER TABLE interaction_events ADD COLUMN plan_id TEXT; ALTER TABLE interaction_events ADD COLUMN feedback TEXT;");
      db.prepare('UPDATE schema_version SET version=2').run();
    }
    const current = db.prepare('SELECT version FROM schema_version LIMIT 1').get().version;
    if (current < 3) {
      const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      const controls = columns('owner_controls'); const plans = columns('proactive_plans');
      if (!controls.has('memory_state')) db.exec("ALTER TABLE owner_controls ADD COLUMN memory_state TEXT NOT NULL DEFAULT 'enabled';");
      if (!controls.has('version')) db.exec("ALTER TABLE owner_controls ADD COLUMN version INTEGER NOT NULL DEFAULT 1;");
      if (!plans.has('memory_refs_json')) db.exec("ALTER TABLE proactive_plans ADD COLUMN memory_refs_json TEXT NOT NULL DEFAULT '[]';");
      db.exec(`CREATE TABLE IF NOT EXISTS memories (memory_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, evidence_session_id TEXT, evidence_event_id TEXT, confidence REAL NOT NULL, sensitivity TEXT NOT NULL, last_confirmed_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, fingerprint)); CREATE INDEX IF NOT EXISTS idx_memories_owner_status ON memories(owner_id,status,expires_at); CREATE INDEX IF NOT EXISTS idx_memories_owner_kind ON memories(owner_id,kind);`);
      db.prepare('UPDATE schema_version SET version=3').run();
    }
    const latest = db.prepare('SELECT version FROM schema_version LIMIT 1').get().version;
    if (latest < 4) {
      db.exec(`CREATE TABLE IF NOT EXISTS proactive_candidates (candidate_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, route_id TEXT, local_date TEXT NOT NULL, window_kind TEXT NOT NULL, status TEXT NOT NULL, scheduled_at TEXT NOT NULL, expires_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, decision_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, local_date, window_kind)); CREATE INDEX IF NOT EXISTS idx_candidates_due ON proactive_candidates(status, scheduled_at);`);
      db.prepare('UPDATE schema_version SET version=4').run();
    }
    const newest = db.prepare('SELECT version FROM schema_version LIMIT 1').get().version;
    if (newest < 5) { db.exec('CREATE TABLE IF NOT EXISTS topic_sources (source_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fingerprint TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, retrieved_at TEXT NOT NULL, match_reason TEXT, score REAL NOT NULL, last_used_at TEXT, memory_refs_json TEXT NOT NULL DEFAULT \'[]\', UNIQUE(owner_id, fingerprint)); CREATE TABLE IF NOT EXISTS sticker_usage (usage_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, sticker_id TEXT NOT NULL, used_at TEXT NOT NULL);'); db.prepare('UPDATE schema_version SET version=5').run(); }
    const currentVersion = db.prepare('SELECT version FROM schema_version LIMIT 1').get().version;
    if (currentVersion < 6) {
      const columns = new Set(db.prepare('PRAGMA table_info(proactive_plans)').all().map((column) => column.name));
      if (!columns.has('retry_scheduled_at')) db.exec('ALTER TABLE proactive_plans ADD COLUMN retry_scheduled_at TEXT;');
      if (!columns.has('retry_count')) db.exec('ALTER TABLE proactive_plans ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;');
      db.prepare('UPDATE schema_version SET version=6').run();
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    db.close();
    throw error;
  }
  return db;
}

export { SCHEMA_VERSION };
