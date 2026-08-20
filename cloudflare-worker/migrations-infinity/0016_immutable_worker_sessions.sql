-- Worker sessions are immutable connection identities. Historical Attempts keep
-- their original session_id forever, while at most one non-disconnected Session
-- may be active for a Worker.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE worker_sessions_runtime_v2 (
  session_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
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
  UNIQUE(worker_id, session_epoch),
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id),
  FOREIGN KEY (pool_id) REFERENCES worker_pool_policy(pool_id)
);

INSERT INTO worker_sessions_runtime_v2
  (session_id, worker_id, pool_id, namespace, instance_id,
   protocol_version, runtime_capability, image_digest,
   session_secret_hash, session_epoch, connected_at, last_seen_at,
   lease_expires_at, disconnected_at)
SELECT session_id, worker_id, pool_id, namespace, instance_id,
       protocol_version, runtime_capability, image_digest,
       session_secret_hash, session_epoch, connected_at, last_seen_at,
       lease_expires_at, disconnected_at
FROM worker_sessions_runtime;

DROP TABLE worker_sessions_runtime;
ALTER TABLE worker_sessions_runtime_v2 RENAME TO worker_sessions_runtime;

CREATE INDEX idx_worker_sessions_runtime_worker_epoch
  ON worker_sessions_runtime(worker_id, session_epoch DESC);
CREATE INDEX idx_worker_sessions_runtime_lease
  ON worker_sessions_runtime(lease_expires_at, disconnected_at);
CREATE UNIQUE INDEX idx_worker_sessions_runtime_one_active
  ON worker_sessions_runtime(worker_id)
  WHERE disconnected_at IS NULL;

PRAGMA defer_foreign_keys = OFF;
