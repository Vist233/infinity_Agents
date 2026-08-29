-- PAPER-FIX-01: durable correlation between a chat turn and its Paper resource.
-- The row contains only opaque identifiers and bounded state; PDF/full-text
-- bytes, R2 keys, provider payloads, and credentials remain outside this table.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper_request_continuations (
  continuation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 255),
  client_request_id TEXT CHECK (client_request_id IS NULL OR length(client_request_id) BETWEEN 1 AND 255),
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'ready', 'running', 'completed', 'failed', 'cancelled', 'expired')),
  active_turn_id TEXT CHECK (active_turn_id IS NULL OR length(active_turn_id) BETWEEN 1 AND 255),
  lease_expires_at INTEGER,
  expires_at INTEGER NOT NULL,
  last_error_code TEXT CHECK (last_error_code IS NULL OR (length(last_error_code) BETWEEN 1 AND 64 AND last_error_code NOT GLOB '*[^A-Z0-9_]*')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (session_id, turn_id, resource_id),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES paper_resources(resource_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_paper_continuations_owner_status
  ON paper_request_continuations(user_id, session_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_continuations_resource_status
  ON paper_request_continuations(resource_id, status, updated_at DESC);
