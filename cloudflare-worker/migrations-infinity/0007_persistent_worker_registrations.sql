-- Persistent Worker identities created by the authenticated user flow.
--
-- `worker_enrollments` remains for the older one-time bootstrap protocol so
-- existing clients can be drained safely. New registrations use this table:
-- the database keeps only the credential digest, while the raw credential is
-- handed to the local Worker configuration once and never returned by list APIs.
-- A namespace is intentionally reusable; it is a pool/scope, not a machine ID.

CREATE TABLE IF NOT EXISTS worker_registrations (
  worker_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  user_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  credential_expires_at INTEGER,
  public_key TEXT,
  trust_level TEXT NOT NULL DEFAULT 'institution_trusted'
    CHECK (trust_level IN ('owner_trusted', 'institution_trusted', 'student_untrusted')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'draining')),
  version TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (worker_id, namespace),
  UNIQUE (credential_hash)
);

CREATE INDEX IF NOT EXISTS idx_worker_registrations_owner
  ON worker_registrations(user_id, namespace, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_worker_registrations_active
  ON worker_registrations(status, revoked_at, credential_expires_at);
