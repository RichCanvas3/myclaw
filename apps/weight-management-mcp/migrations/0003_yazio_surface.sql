-- Daily targets, water, fasting, favorites (Yazio-style data; logic stays in MCP/agent)

CREATE TABLE IF NOT EXISTS wm_daily_targets (
  scope_id TEXT PRIMARY KEY,
  targets_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wm_water_log (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  amount_ml REAL NOT NULL,
  source TEXT,
  telegram_chat_id TEXT,
  telegram_message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_water_scope_time ON wm_water_log(scope_id, at_ms DESC);

CREATE TABLE IF NOT EXISTS wm_fast_windows (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  label TEXT,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_fast_scope_start ON wm_fast_windows(scope_id, start_ms DESC);

CREATE TABLE IF NOT EXISTS wm_food_favorites (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  calories REAL,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  last_used_at INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_wm_fav_scope_name ON wm_food_favorites(scope_id, name);
