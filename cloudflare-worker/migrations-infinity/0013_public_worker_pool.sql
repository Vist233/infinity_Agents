-- Public execution pool and owner-first task routing.
--
-- The legacy user_id columns remain for compatibility with older clients and
-- queries.  New owner_user_id is nullable so platform-owned public Workers do
-- not masquerade as a browser user.

CREATE TABLE IF NOT EXISTS worker_pools (
  pool_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('public', 'user')),
  namespace TEXT NOT NULL,
  owner_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'draining', 'revoked')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_pools_public_namespace
  ON worker_pools(kind, namespace) WHERE kind = 'public';
CREATE INDEX IF NOT EXISTS idx_worker_pools_owner
  ON worker_pools(owner_user_id, kind, status);

CREATE TABLE IF NOT EXISTS worker_admin_events (
  event_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('created', 'credential_recovered', 'credential_rotated', 'revoked', 'pool_viewed')),
  worker_id TEXT,
  pool_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_admin_events_pool
  ON worker_admin_events(pool_id, created_at DESC);

ALTER TABLE worker_registrations ADD COLUMN worker_kind TEXT NOT NULL DEFAULT 'user'
  CHECK (worker_kind IN ('public', 'user'));
ALTER TABLE worker_registrations ADD COLUMN pool_id TEXT;
ALTER TABLE worker_registrations ADD COLUMN owner_user_id TEXT;
UPDATE worker_registrations
SET owner_user_id = user_id
WHERE worker_kind = 'user' AND owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_worker_registrations_pool
  ON worker_registrations(pool_id, worker_kind, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_worker_registrations_owner_v2
  ON worker_registrations(owner_user_id, namespace, status, created_at DESC);

ALTER TABLE worker_sessions ADD COLUMN worker_kind TEXT NOT NULL DEFAULT 'user'
  CHECK (worker_kind IN ('public', 'user'));
ALTER TABLE worker_sessions ADD COLUMN pool_id TEXT;
ALTER TABLE worker_sessions ADD COLUMN owner_user_id TEXT;
UPDATE worker_sessions
SET owner_user_id = user_id
WHERE worker_kind = 'user' AND owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_worker_sessions_owner
  ON worker_sessions(owner_user_id, lease_expires_at);

ALTER TABLE worker_offers ADD COLUMN worker_kind TEXT NOT NULL DEFAULT 'user'
  CHECK (worker_kind IN ('public', 'user'));
ALTER TABLE worker_offers ADD COLUMN priority INTEGER NOT NULL DEFAULT 1
  CHECK (priority IN (1, 2));
ALTER TABLE worker_offers ADD COLUMN superseded_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_worker_offers_active_priority
  ON worker_offers(task_id, superseded_at, accepted_at, priority, expires_at);

ALTER TABLE tasks ADD COLUMN dispatch_policy TEXT NOT NULL DEFAULT 'owner_then_public'
  CHECK (dispatch_policy IN ('owner_then_public'));
CREATE INDEX IF NOT EXISTS idx_tasks_dispatch_queue
  ON tasks(status, dispatch_policy, created_at);

-- Stable public pool. The namespace can be changed only through the deployment
-- configuration before provisioning public registrations; ordinary users never
-- submit this value.
INSERT OR IGNORE INTO worker_pools
  (pool_id, kind, namespace, owner_user_id, status, created_by, created_at, updated_at)
VALUES
  ('public-default', 'public', 'infinity-public', NULL, 'active', NULL,
   CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));
