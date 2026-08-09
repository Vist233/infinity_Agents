-- Fencing and verification hardening.  A Worker can only quarantine a result;
-- a separately authenticated verifier must publish it as a user-visible result.

ALTER TABLE tasks ADD COLUMN lease_namespace TEXT;
ALTER TABLE artifacts ADD COLUMN manifest_json TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_lease_namespace
  ON tasks(lease_worker_id, lease_namespace, lease_epoch);
