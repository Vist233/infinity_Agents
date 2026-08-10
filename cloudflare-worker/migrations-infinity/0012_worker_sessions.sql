-- One active reverse-handshake session per persistent Worker registration.
--
-- A credential identifies a Worker registration.  This table identifies the
-- currently running instance of that Worker.  The lease is deliberately short
-- so a stopped machine becomes available again without revoking its durable
-- registration or issuing a new credential.
CREATE TABLE IF NOT EXISTS worker_sessions (
  worker_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  connected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  disconnected_at INTEGER,
  PRIMARY KEY (worker_id, namespace),
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_sessions_lease
  ON worker_sessions(lease_expires_at);
