-- Infinity Agents / PaperAgent D1 schema.
-- This database is intentionally separate from ImageJudge's D1 database.

CREATE TABLE IF NOT EXISTS auth_sessions (
  sid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT,
  access_token TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
  ON chat_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session
  ON chat_messages(session_id, id);

CREATE TABLE IF NOT EXISTS paper_authorizations (
  session_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, ref)
);

CREATE TABLE IF NOT EXISTS paper_cache (
  cache_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_cache_expires ON paper_cache(expires_at);

CREATE TABLE IF NOT EXISTS daily_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
