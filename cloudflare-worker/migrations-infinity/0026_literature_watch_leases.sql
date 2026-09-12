-- Serialize scheduled literature watcher runs and fence cursor commits.
-- The lease columns are nullable for backward-compatible rows created before
-- the watcher was made concurrency-safe.
ALTER TABLE literature_watch_state ADD COLUMN lease_owner TEXT;
ALTER TABLE literature_watch_state ADD COLUMN lease_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_literature_watch_lease
  ON literature_watch_state(source, query, lease_expires_at);
