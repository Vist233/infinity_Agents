-- Dedicated Paper Processor control sessions. These are not public Worker
-- sessions and persist only a hash of the short-lived session capability.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper_processor_sessions (
  processor_session_id TEXT PRIMARY KEY,
  processor_id TEXT NOT NULL CHECK (length(processor_id) BETWEEN 1 AND 255),
  instance_id TEXT NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 255),
  session_token_hash TEXT NOT NULL CHECK (length(session_token_hash) = 64),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_processor_sessions_token
  ON paper_processor_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_paper_processor_sessions_active
  ON paper_processor_sessions(processor_id, expires_at)
  WHERE revoked_at IS NULL;

-- One live Processor lease per resource. Expired/terminal attempts remain
-- auditable while a concurrent claim cannot create two active owners.
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_attempts_one_active
  ON paper_processing_attempts(resource_id)
  WHERE status IN ('claimed', 'downloading', 'extracting', 'uploading');
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_processor_one_active
  ON paper_processing_attempts(processor_id)
  WHERE status IN ('claimed', 'downloading', 'extracting', 'uploading');
