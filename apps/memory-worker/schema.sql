-- Durable memory records (identity, household, community, BDI, goals, etc.)
CREATE TABLE IF NOT EXISTS mem_records (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS mem_records_unique
  ON mem_records(scope_id, namespace, key);

CREATE INDEX IF NOT EXISTS mem_records_ns
  ON mem_records(namespace);

-- Append-only audit log for orchestration outcomes
CREATE TABLE IF NOT EXISTS mem_events (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mem_events_scope
  ON mem_events(scope_id, created_at);

