-- Worker Control API: one-time enrollment, short-lived offers, fenced attempts
-- and quarantine artifact publication.  This migration is additive so the
-- existing browser/session/task data remains intact.

ALTER TABLE worker_enrollments ADD COLUMN credential_hash TEXT;
ALTER TABLE worker_enrollments ADD COLUMN credential_expires_at INTEGER;
ALTER TABLE worker_enrollments ADD COLUMN public_key TEXT;
ALTER TABLE worker_enrollments ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'owner_trusted';
ALTER TABLE worker_enrollments ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE worker_enrollments ADD COLUMN version TEXT;
ALTER TABLE worker_enrollments ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE worker_enrollments ADD COLUMN last_seen_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_enrollments_credential
  ON worker_enrollments(credential_hash) WHERE credential_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_worker_enrollments_active
  ON worker_enrollments(status, revoked_at, credential_expires_at);

ALTER TABLE tasks ADD COLUMN task_class TEXT NOT NULL DEFAULT 'owner_trusted';
ALTER TABLE tasks ADD COLUMN lease_worker_id TEXT;
ALTER TABLE tasks ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE tasks ADD COLUMN lease_claim_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_worker_queue ON tasks(status, task_class, created_at);

CREATE TABLE IF NOT EXISTS worker_offers (
  offer_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_offers_worker
  ON worker_offers(worker_id, accepted_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_worker_offers_task
  ON worker_offers(task_id, accepted_at, expires_at);

CREATE TABLE IF NOT EXISTS worker_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'succeeded', 'failed', 'expired', 'cancelled')),
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(task_id, fencing_epoch),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_attempts_worker
  ON worker_attempts(worker_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_worker_attempts_task
  ON worker_attempts(task_id, fencing_epoch);

ALTER TABLE artifacts ADD COLUMN attempt_id TEXT;
ALTER TABLE artifacts ADD COLUMN worker_id TEXT;
ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON artifacts(attempt_id, status);
