-- Meal photo analyses (vision output persistence)

CREATE TABLE IF NOT EXISTS wm_meal_analyses (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  model TEXT,
  summary TEXT,
  raw_json TEXT NOT NULL,
  image_ref_json TEXT,
  telegram_chat_id TEXT,
  telegram_message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_meal_analyses_scope_time ON wm_meal_analyses(scope_id, at_ms DESC);

ALTER TABLE wm_food_entries ADD COLUMN analysis_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wm_food_analysis ON wm_food_entries(scope_id, analysis_id);
