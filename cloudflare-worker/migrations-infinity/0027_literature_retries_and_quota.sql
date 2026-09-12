-- Durable literature ingestion retries/dead letters and an atomic daily
-- reservation counter. Provider pages may be consumed even when a catalog
-- write fails; this ledger keeps the failed record available for retry.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS literature_watch_failures (
  failure_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (length(record_json) <= 65536),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 20),
  next_retry_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 512),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source, query, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_literature_watch_failures_due
  ON literature_watch_failures(source, query, status, next_retry_at);

CREATE TABLE IF NOT EXISTS literature_watch_daily_quota (
  owner_user_id TEXT NOT NULL,
  day_start INTEGER NOT NULL,
  limit_count INTEGER NOT NULL CHECK (limit_count > 0 AND limit_count <= 500),
  reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, day_start)
);
