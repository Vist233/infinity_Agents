-- Infinity Agents product settings are separate from Zhang Auth identity data.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  locale TEXT NOT NULL DEFAULT 'zh'
    CHECK (locale IN ('zh', 'en')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
