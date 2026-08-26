-- Additive Paper Workspace observability and retry-safe object cleanup.
-- Payloads are bounded metadata only; PDF/text/image bytes stay in R2.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper_resource_audit_events (
  event_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  attempt_id TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('materialize', 'download', 'extraction', 'upload', 'image_analysis', 'cancel', 'delete', 'cleanup')),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'denied', 'cancelled')),
  error_code TEXT CHECK (error_code IS NULL OR error_code GLOB '[A-Z0-9_]*'),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (length(metadata_json) <= 4096),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES paper_resources(resource_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES paper_processing_attempts(attempt_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_audit_resource_created
  ON paper_resource_audit_events(resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS paper_cleanup_jobs (
  cleanup_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 100),
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code GLOB '[A-Z0-9_]*'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES paper_resources(resource_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_cleanup_due
  ON paper_cleanup_jobs(status, next_attempt_at);
