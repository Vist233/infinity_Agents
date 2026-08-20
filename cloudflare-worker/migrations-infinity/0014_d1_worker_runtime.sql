-- Canonical D1 task/Worker runtime for the 2026-08-20 architecture.
--
-- D1 is SQLite.  This migration deliberately does not introduce a PostgreSQL
-- adapter, Hyperdrive binding, RLS policy, or a second database.  The tables
-- created here are the only production data-plane tables used by Worker v2.
-- The additive legacy tables from 0003-0013 remain only long enough to drain
-- old browser records and are not consulted by the v2 control plane.

CREATE TABLE IF NOT EXISTS worker_pool_policy (
  policy_id INTEGER PRIMARY KEY CHECK (policy_id = 1),
  pool_id TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode = 'public'),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO worker_pool_policy
  (policy_id, pool_id, namespace, mode, updated_at)
VALUES
  (1, 'public-default', 'infinity-public', 'public', CAST(strftime('%s', 'now') AS INTEGER));

INSERT OR IGNORE INTO worker_pools
  (pool_id, kind, namespace, owner_user_id, status, created_by, created_at, updated_at)
VALUES
  ('public-default', 'public', 'infinity-public', NULL, 'active', NULL,
   CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));

-- Normalize compatibility rows so an old process cannot accidentally retain a
-- private/trust-specific dispatch scope while the new tables are populated.
UPDATE worker_registrations
SET worker_kind = 'public',
    pool_id = 'public-default',
    owner_user_id = NULL,
    user_id = 'system:public-workers',
    trust_level = 'institution_trusted'
WHERE status <> 'revoked';

UPDATE worker_sessions
SET worker_kind = 'public',
    pool_id = 'public-default',
    owner_user_id = NULL,
    user_id = 'system:public-workers';

UPDATE worker_offers
SET worker_kind = 'public', priority = 1;

CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL DEFAULT 'public-default',
  namespace TEXT NOT NULL DEFAULT 'infinity-public',
  created_by TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  credential_ciphertext TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'draining', 'revoked')),
  protocol_version TEXT NOT NULL DEFAULT '2',
  runtime_capability TEXT NOT NULL DEFAULT 'goal-driven-claude-code',
  image_digest TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (pool_id) REFERENCES worker_pool_policy(pool_id)
);
CREATE INDEX IF NOT EXISTS idx_workers_pool_status
  ON workers(pool_id, namespace, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workers_created_by
  ON workers(created_by, created_at DESC);

-- Migrate public persistent registrations once.  The old trust column is not
-- copied: v2 has no trust-level decision or private Worker pool.
INSERT OR IGNORE INTO workers
  (worker_id, pool_id, namespace, created_by, credential_hash,
   credential_ciphertext, status, protocol_version, runtime_capability,
   image_digest, last_seen_at, created_at, updated_at, revoked_at)
SELECT worker_id,
       'public-default',
       'infinity-public',
       CASE
         WHEN user_id IS NULL OR user_id = 'system:public-workers'
           THEN 'system:public-workers'
         ELSE user_id
       END,
       credential_hash,
       credential_ciphertext,
       CASE WHEN status IN ('active', 'draining', 'revoked') THEN status ELSE 'revoked' END,
       COALESCE(NULLIF(version, ''), '2'),
       'goal-driven-claude-code',
       NULL,
       last_seen_at,
       created_at,
       COALESCE(last_seen_at, created_at),
       revoked_at
FROM worker_registrations
WHERE worker_kind = 'public' AND credential_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS worker_sessions_runtime (
  session_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL UNIQUE,
  pool_id TEXT NOT NULL DEFAULT 'public-default',
  namespace TEXT NOT NULL DEFAULT 'infinity-public',
  instance_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  runtime_capability TEXT NOT NULL,
  image_digest TEXT,
  session_secret_hash TEXT NOT NULL,
  session_epoch INTEGER NOT NULL DEFAULT 1,
  connected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  disconnected_at INTEGER,
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id),
  FOREIGN KEY (pool_id) REFERENCES worker_pool_policy(pool_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_runtime_lease
  ON worker_sessions_runtime(lease_expires_at, disconnected_at);

ALTER TABLE task_specs ADD COLUMN goal TEXT NOT NULL DEFAULT '';
ALTER TABLE task_specs ADD COLUMN prompt_template_version TEXT NOT NULL DEFAULT 'goal-driven-executor-v1';

ALTER TABLE tasks ADD COLUMN execution_pool_id TEXT NOT NULL DEFAULT 'public-default';
ALTER TABLE tasks ADD COLUMN active_attempt_id TEXT;
ALTER TABLE tasks ADD COLUMN lease_token_hash TEXT;
ALTER TABLE tasks ADD COLUMN cancel_requested_at INTEGER;
UPDATE tasks SET task_class = 'public', execution_pool_id = 'public-default';
CREATE INDEX IF NOT EXISTS idx_tasks_public_queue
  ON tasks(status, execution_pool_id, created_at, task_id);

CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  lease_token_hash TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'succeeded', 'failed', 'expired', 'cancelled')),
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(task_id, fencing_epoch),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id),
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id),
  FOREIGN KEY (session_id) REFERENCES worker_sessions_runtime(session_id)
);
CREATE INDEX IF NOT EXISTS idx_task_attempts_worker_active
  ON task_attempts(worker_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task
  ON task_attempts(task_id, fencing_epoch DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
  ON outbox_events(status, next_attempt_at, created_at);

ALTER TABLE artifacts ADD COLUMN release_state TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE artifacts ADD COLUMN upload_id TEXT;
ALTER TABLE artifacts ADD COLUMN released_at INTEGER;
UPDATE artifacts SET release_state = 'published' WHERE status = 'published';

CREATE TABLE IF NOT EXISTS artifact_uploads (
  upload_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size_bytes INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'aborted')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id),
  FOREIGN KEY (attempt_id) REFERENCES task_attempts(attempt_id),
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_uploads_attempt
  ON artifact_uploads(attempt_id, status);

CREATE TABLE IF NOT EXISTS artifact_upload_parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number > 0),
  etag TEXT NOT NULL,
  part_size_bytes INTEGER NOT NULL,
  part_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number),
  FOREIGN KEY (upload_id) REFERENCES artifact_uploads(upload_id)
);

-- All newly created tasks are public-pool tasks.  Keep the old dispatch_policy
-- column only as a compatibility read; v2 never uses owner-first routing.
UPDATE tasks SET execution_pool_id = 'public-default';
