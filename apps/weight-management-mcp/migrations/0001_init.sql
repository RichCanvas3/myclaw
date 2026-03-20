-- D1 schema for weight-management-mcp

CREATE TABLE IF NOT EXISTS wm_profiles (
  scope_id TEXT PRIMARY KEY,
  scope_json TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wm_weights (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  weight_kg REAL,
  bodyfat_pct REAL,
  notes TEXT,
  source TEXT,
  telegram_chat_id TEXT,
  telegram_message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_weights_scope_time ON wm_weights(scope_id, at_ms DESC);

CREATE TABLE IF NOT EXISTS wm_food_entries (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  meal TEXT,
  text TEXT,
  calories REAL,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  fiber_g REAL,
  sugar_g REAL,
  sodium_mg REAL,
  source TEXT,
  telegram_chat_id TEXT,
  telegram_message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_food_scope_time ON wm_food_entries(scope_id, at_ms DESC);

CREATE TABLE IF NOT EXISTS wm_photos (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  caption TEXT,
  tags_json TEXT NOT NULL,
  telegram_chat_id TEXT,
  telegram_message_id INTEGER,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  photo_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_photos_scope_time ON wm_photos(scope_id, at_ms DESC);

CREATE TABLE IF NOT EXISTS wm_events (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_events_scope_time ON wm_events(scope_id, at_ms DESC);

