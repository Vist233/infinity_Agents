-- C7 runtime hardening: durable finalize ownership and recoverable outbox claims.

ALTER TABLE artifact_uploads ADD COLUMN finalize_owner TEXT;
ALTER TABLE artifact_uploads ADD COLUMN finalize_started_at INTEGER;
ALTER TABLE artifact_uploads ADD COLUMN finalize_artifact_id TEXT;
CREATE INDEX IF NOT EXISTS idx_artifact_uploads_finalize
  ON artifact_uploads(status, finalize_started_at);

-- Old finalize races may have produced more than one metadata row for one
-- upload_id. Pick the oldest stable row, repoint Task results, and remove only
-- duplicate metadata before enforcing uniqueness. R2 objects are immutable;
-- unreferenced duplicate objects can be garbage-collected separately.
CREATE TABLE IF NOT EXISTS c7_artifact_upload_winners (
  upload_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL
);
DELETE FROM c7_artifact_upload_winners;
INSERT INTO c7_artifact_upload_winners (upload_id, artifact_id)
SELECT a.upload_id, a.artifact_id
FROM artifacts a
WHERE a.upload_id IS NOT NULL
  AND a.artifact_id = (
    SELECT candidate.artifact_id
    FROM artifacts candidate
    WHERE candidate.upload_id = a.upload_id
    ORDER BY candidate.created_at ASC, candidate.artifact_id ASC
    LIMIT 1
  );
UPDATE tasks
SET result_artifact_id = (
  SELECT winner.artifact_id
  FROM artifacts current
  JOIN c7_artifact_upload_winners winner ON winner.upload_id = current.upload_id
  WHERE current.artifact_id = tasks.result_artifact_id
)
WHERE result_artifact_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM artifacts current
    JOIN c7_artifact_upload_winners winner ON winner.upload_id = current.upload_id
    WHERE current.artifact_id = tasks.result_artifact_id
      AND winner.artifact_id <> current.artifact_id
  );
DELETE FROM artifacts
WHERE upload_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM c7_artifact_upload_winners winner
    WHERE winner.upload_id = artifacts.upload_id
      AND winner.artifact_id <> artifacts.artifact_id
  );
DROP TABLE c7_artifact_upload_winners;
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_upload_unique
  ON artifacts(upload_id) WHERE upload_id IS NOT NULL;

ALTER TABLE outbox_events ADD COLUMN publishing_started_at INTEGER;
ALTER TABLE outbox_events ADD COLUMN publishing_owner TEXT;
CREATE INDEX IF NOT EXISTS idx_outbox_events_publishing
  ON outbox_events(status, publishing_started_at, publishing_owner);

-- Only one request may rotate a site's OAuth refresh token at a time. The
-- owner token also fences a stale provider response from overwriting a newer
-- session after a takeover.
ALTER TABLE auth_sessions ADD COLUMN refresh_owner TEXT;
ALTER TABLE auth_sessions ADD COLUMN refresh_started_at INTEGER;
ALTER TABLE auth_sessions ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh_owner
  ON auth_sessions(refresh_owner, refresh_started_at);

-- Revoked OAuth sessions never need provider tokens again. Active legacy
-- rows are upgraded lazily on their next authenticated read.
UPDATE auth_sessions
SET access_token = '', refresh_token = '', refresh_owner = NULL,
    refresh_started_at = NULL
WHERE revoked_at IS NOT NULL;
