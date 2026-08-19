-- PostgreSQL security profile for a clean local acceptance database.
-- Run as a database owner/administrator, never from the API process:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rls_roles.sql
-- For a non-superuser login that opens the runtime pool, also pass its login
-- role so SET ROLE is explicitly auditable:
--   psql "$DATABASE_URL" -v RLS_API_LOGIN_ROLE=acceptance_api \
--     -v RLS_TRUST_ISSUER_LOGIN_ROLE=acceptance_trust_issuer \
--     -v RLS_USER_CONTEXT_SECRET='local-only-secret' \
--     -v RLS_WORKER_LOGIN_ROLE=acceptance_worker \
--     -v RLS_WORKER_GATEWAY_LOGIN_ROLE=acceptance_worker_gateway \
--     -v RLS_OUTBOX_LOGIN_ROLE=acceptance_outbox \
--     -v RLS_REAPER_LOGIN_ROLE=acceptance_reaper \
--     -v ON_ERROR_STOP=1 -f scripts/rls_roles.sql
--
-- The application must set app.user_id on the same checked-out connection as
-- each request query and reset it before release; the Worker must set
-- app.worker_id plus app.worker_credential. An unset context is intentionally
-- denied by every policy. This script is not applied automatically because an
-- existing database may still contain legacy rows that need an explicit
-- migration review.

BEGIN;

\if :{?RLS_USER_CONTEXT_SECRET}
\else
DO $$ BEGIN
  RAISE EXCEPTION 'RLS_USER_CONTEXT_SECRET is required';
END $$;
\endif

ALTER TABLE IF EXISTS task_attempts DROP CONSTRAINT IF EXISTS chk_task_attempt_status;
ALTER TABLE IF EXISTS task_attempts ADD CONSTRAINT chk_task_attempt_status CHECK (status IN (
  'running', 'succeeded', 'failed', 'lost', 'cancelled', 'timeout'
));
ALTER TABLE IF EXISTS artifacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS artifacts ADD COLUMN IF NOT EXISTS cleanup_completed_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS execution_pool TEXT NOT NULL DEFAULT 'public-default';
UPDATE tasks SET execution_pool = 'public-default'
WHERE execution_pool IS NULL OR btrim(execution_pool) = '';
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS execution_pool TEXT NOT NULL DEFAULT 'public-default';
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS protocol_version TEXT NOT NULL DEFAULT 'legacy-v0';
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS runtime_capability TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS image_digest TEXT;
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS active_instance_id TEXT;
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS active_instance_expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS session_epoch BIGINT NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE IF EXISTS worker_enrollments ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ;
UPDATE worker_enrollments
SET execution_pool = 'public-default'
WHERE execution_pool IS NULL OR btrim(execution_pool) = '';
UPDATE worker_enrollments
SET protocol_version = 'legacy-v0', runtime_capability = 'legacy', ready = FALSE
WHERE protocol_version IS NULL OR btrim(protocol_version) = '';
CREATE INDEX IF NOT EXISTS idx_worker_enrollments_instance
  ON worker_enrollments (active_instance_id, active_instance_expires_at)
  WHERE active_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_cleanup
  ON artifacts (deleted_at, cleanup_completed_at, created_at)
  WHERE deleted_at IS NOT NULL;

-- Used by the database-side Worker proof below.  The Worker only knows its
-- own persistent credential; an ID alone is never accepted as an RLS actor.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinity_api') THEN
    CREATE ROLE infinity_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinity_worker') THEN
    CREATE ROLE infinity_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinity_outbox') THEN
    CREATE ROLE infinity_outbox NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinity_trust_issuer') THEN
    CREATE ROLE infinity_trust_issuer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinity_reaper') THEN
    CREATE ROLE infinity_reaper NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- Normalize pre-existing role attributes too. A role that was created earlier
-- as a superuser must not silently make the preflight look like a real RLS
-- boundary while still bypassing every policy.
ALTER ROLE infinity_api NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE infinity_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE infinity_outbox NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE infinity_trust_issuer NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE infinity_reaper NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

-- Every runtime process receives only its own managed role. Do not restore a
-- combined runtime-login escape hatch: it would let an API or Worker opt into
-- Outbox/Reaper capabilities by changing one connection setting.
\if :{?RLS_API_LOGIN_ROLE}
GRANT infinity_api TO :"RLS_API_LOGIN_ROLE";
REVOKE infinity_trust_issuer FROM :"RLS_API_LOGIN_ROLE";
\endif
\if :{?RLS_TRUST_ISSUER_LOGIN_ROLE}
GRANT infinity_trust_issuer TO :"RLS_TRUST_ISSUER_LOGIN_ROLE";
\endif
\if :{?RLS_WORKER_LOGIN_ROLE}
GRANT infinity_worker TO :"RLS_WORKER_LOGIN_ROLE";
\endif
\if :{?RLS_WORKER_B_LOGIN_ROLE}
GRANT infinity_worker TO :"RLS_WORKER_B_LOGIN_ROLE";
\endif
\if :{?RLS_WORKER_GATEWAY_LOGIN_ROLE}
GRANT infinity_worker TO :"RLS_WORKER_GATEWAY_LOGIN_ROLE";
\endif
\if :{?RLS_OUTBOX_LOGIN_ROLE}
GRANT infinity_outbox TO :"RLS_OUTBOX_LOGIN_ROLE";
\endif
\if :{?RLS_REAPER_LOGIN_ROLE}
GRANT infinity_reaper TO :"RLS_REAPER_LOGIN_ROLE";
\endif

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.rls_runtime_secrets (
  secret_name TEXT PRIMARY KEY,
  secret_value TEXT NOT NULL
);
REVOKE ALL ON app.rls_runtime_secrets FROM PUBLIC, infinity_api, infinity_worker,
  infinity_outbox, infinity_trust_issuer, infinity_reaper;
INSERT INTO app.rls_runtime_secrets (secret_name, secret_value)
VALUES ('user_context', :'RLS_USER_CONTEXT_SECRET')
ON CONFLICT (secret_name) DO UPDATE SET secret_value = EXCLUDED.secret_value;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  candidate TEXT := NULLIF(current_setting('app.user_id', true), '');
  proof TEXT := lower(NULLIF(current_setting('app.user_proof', true), ''));
  secret TEXT;
BEGIN
  IF candidate IS NULL OR proof IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT secret_value INTO secret
  FROM app.rls_runtime_secrets
  WHERE secret_name = 'user_context';
  IF secret IS NULL OR proof <> encode(hmac(candidate, secret, 'sha256'), 'hex') THEN
    RETURN NULL;
  END IF;
  RETURN candidate;
END
$$;
REVOKE ALL ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO infinity_api;

CREATE OR REPLACE FUNCTION app.current_worker_id() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT w.worker_id
  FROM public.worker_enrollments w
  WHERE w.worker_id = NULLIF(current_setting('app.worker_id', true), '')
    AND w.status = 'active'
    AND w.revoked_at IS NULL
    AND w.namespace = NULLIF(current_setting('app.worker_namespace', true), '')
    AND w.credential_hash = encode(
      digest(NULLIF(current_setting('app.worker_credential', true), ''), 'sha256'),
      'hex'
    )
  LIMIT 1
$$;

-- A credential is not enough to enter the new data plane.  The Worker must
-- have completed the current protocol handshake, hold the one active instance
-- fence, and be marked ready after its central Redis connection is healthy.
-- This helper is deliberately additive: it does not grant any task access by
-- itself and is called only by the existing Worker task/input policies.
CREATE OR REPLACE FUNCTION app.worker_session_compatible(actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.worker_enrollments w
    WHERE w.worker_id = actor
      AND w.status = 'active'
      AND w.revoked_at IS NULL
      AND w.execution_pool = 'public-default'
      AND w.protocol_version = NULLIF(current_setting('app.worker_protocol_version', true), '')
      AND w.runtime_capability = NULLIF(current_setting('app.worker_runtime_capability', true), '')
      AND w.active_instance_id = NULLIF(current_setting('app.worker_instance_id', true), '')
      AND w.session_epoch = NULLIF(current_setting('app.worker_session_epoch', true), '')::bigint
      AND w.ready = TRUE
  )
$$;
REVOKE ALL ON FUNCTION app.worker_session_compatible(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_session_compatible(text) TO infinity_worker;

-- Security-definer lookup avoids recursive RLS evaluation when a policy needs
-- to inspect project_members and projects. The script must be run by the
-- database owner/administrator so this helper has a controlled owner.
CREATE OR REPLACE FUNCTION app.project_access(target_project uuid, actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.project_id = target_project AND p.owner_user_id = actor
  ) OR EXISTS (
    SELECT 1 FROM project_members pm
    WHERE pm.project_id = target_project AND pm.user_id = actor
  )
$$;
REVOKE ALL ON FUNCTION app.project_access(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_access(uuid, text) TO infinity_api, infinity_worker;

-- A general Worker is scoped to the account that enrolled it.  Full-trust
-- Workers are the explicitly privileged server-side execution tier and may
-- process all tasks.  This closes the gap where a valid general credential
-- could otherwise claim another user's queued task from the shared Redis
-- stream.  The function is security-definer so the policy does not recurse
-- through worker_enrollments RLS.
CREATE OR REPLACE FUNCTION app.worker_can_access_task(target_task uuid, actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tasks t
    JOIN worker_enrollments w ON w.worker_id = actor
    WHERE t.task_id = target_task
      AND w.status = 'active'
      AND w.revoked_at IS NULL
      AND w.namespace = NULLIF(current_setting('app.worker_namespace', true), '')
      AND w.credential_hash = encode(
        digest(NULLIF(current_setting('app.worker_credential', true), ''), 'sha256'),
        'hex'
      )
      AND app.worker_session_compatible(actor)
      AND (
        w.trust_level = 'full'
        OR (w.trust_level = 'general'
            AND w.owner_user_id IS NOT NULL
            AND t.created_by = w.owner_user_id)
      )
  )
$$;
REVOKE ALL ON FUNCTION app.worker_can_access_task(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_can_access_task(uuid, text) TO infinity_worker;

-- RLS answers *which* task a Worker may touch. This trigger answers *how*
-- that row may change, so a Worker with a valid database connection cannot
-- jump from queued/terminal state, replace an active lease, or point a task
-- at an unrelated artifact by issuing ad-hoc SQL. The normal application CAS
-- predicates remain in place; this is the database-side defense in depth.
CREATE OR REPLACE FUNCTION app.worker_task_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE
  actor text;
BEGIN
  IF current_user <> 'infinity_worker' THEN
    RETURN NEW;
  END IF;

  actor := app.current_worker_id();
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Worker database context is not credential-bound';
  END IF;

  IF OLD.status = 'queued' THEN
    IF NEW.status <> 'claimed'
       OR NEW.lease_owner IS DISTINCT FROM actor
       OR NEW.lease_token IS NULL
       OR NEW.lease_expires_at IS NULL
       OR NEW.lease_expires_at <= NOW()
       OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'Invalid Worker claim transition';
    END IF;
  ELSE
    IF OLD.status NOT IN ('claimed', 'running')
       OR OLD.lease_owner IS DISTINCT FROM actor
       OR OLD.lease_token IS NULL
       OR OLD.lease_expires_at IS NULL
       OR OLD.lease_expires_at <= NOW() THEN
      RAISE EXCEPTION 'Worker does not hold an active task lease';
    END IF;
    IF NEW.status NOT IN ('claimed', 'running', 'succeeded', 'failed', 'cancelled', 'timeout', 'queued') THEN
      RAISE EXCEPTION 'Invalid Worker task state transition';
    END IF;
    IF OLD.status = 'running' AND NEW.status = 'claimed' THEN
      RAISE EXCEPTION 'Worker cannot move a running task back to claimed';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at
       OR NEW.phase IS DISTINCT FROM OLD.phase
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'Worker changed an immutable task control field';
    END IF;
    IF NEW.status = 'queued' THEN
      IF NEW.lease_owner IS NOT NULL
         OR NEW.lease_token IS NOT NULL
         OR NEW.lease_expires_at IS NOT NULL
         OR NEW.active_attempt_id IS NOT NULL THEN
        RAISE EXCEPTION 'Requeued Worker task must release its lease';
      END IF;
    ELSE
      IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
         OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
         OR NEW.lease_expires_at IS NULL
         OR NEW.lease_expires_at <= NOW() THEN
        RAISE EXCEPTION 'Worker cannot replace or expire its active lease';
      END IF;
    END IF;
  END IF;

  IF NEW.active_attempt_id IS DISTINCT FROM OLD.active_attempt_id THEN
    IF NEW.status = 'queued' AND NEW.active_attempt_id IS NULL THEN
      NULL; -- normal requeue/recovery release
    ELSIF OLD.active_attempt_id IS NULL
          AND NEW.active_attempt_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM task_attempts a
            WHERE a.task_attempt_id = NEW.active_attempt_id
              AND a.task_id = NEW.task_id
              AND a.worker_id = actor
              AND a.status IN ('claimed', 'running')
          ) THEN
      NULL; -- claim attaches the attempt created in the same transaction
    ELSE
      RAISE EXCEPTION 'Worker cannot replace the active attempt';
    END IF;
  END IF;

  IF NEW.result_artifact_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM artifacts a
       WHERE a.artifact_id = NEW.result_artifact_id
         AND a.task_id = NEW.task_id
         AND a.task_attempt_id = NEW.active_attempt_id
     ) THEN
    RAISE EXCEPTION 'Task result artifact is not attached to the active attempt';
  END IF;

  IF NEW.status = 'succeeded' AND NEW.result_artifact_id IS NULL THEN
    RAISE EXCEPTION 'Succeeded Worker task must have a result artifact';
  END IF;

  IF NEW.status IN ('succeeded', 'failed', 'cancelled', 'timeout')
     AND NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'Terminal Worker task must have finished_at';
  END IF;
  IF NEW.status IN ('claimed', 'running')
     AND NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
    RAISE EXCEPTION 'Active Worker task cannot set finished_at';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.worker_task_update_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_task_update_guard() TO infinity_worker;

-- A Worker may only register a local artifact in the operator-configured
-- output root and the task's exact output directory. The API's remote upload
-- path adds a fixed `remote/` component, so both forms are accepted while
-- traversal and sibling-task paths remain rejected. The API download path
-- still performs the filesystem/symlink checks.
\if :{?RLS_ARTIFACT_ROOT}
\else
\set RLS_ARTIFACT_ROOT '/workspace/task-outputs'
\endif

SELECT format(
  'CREATE OR REPLACE FUNCTION app.worker_artifact_root() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $fn$ SELECT %L::text $fn$;',
  :'RLS_ARTIFACT_ROOT'
)\gexec
REVOKE ALL ON FUNCTION app.worker_artifact_root() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_artifact_root() TO infinity_worker;

CREATE OR REPLACE FUNCTION app.worker_artifact_path_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF current_user <> 'infinity_worker' THEN
    RETURN NEW;
  END IF;
  IF app.current_worker_id() IS NULL THEN
    RAISE EXCEPTION 'Worker database context is not credential-bound';
  END IF;
  IF NEW.storage_backend = 'local'
     AND (
       NEW.storage_path IS NULL
       OR NEW.storage_path !~ '^/'
       OR NEW.storage_path ~ '(^|/)\.\.(/|$)'
       OR app.worker_artifact_root() IS NULL
       OR NOT (
         position(
           (rtrim(app.worker_artifact_root(), '/') || '/' || NEW.task_id::text || '/')
           in NEW.storage_path
         ) = 1
         OR position(
           (rtrim(app.worker_artifact_root(), '/') || '/remote/' || NEW.task_id::text || '/')
           in NEW.storage_path
         ) = 1
       )
     ) THEN
    RAISE EXCEPTION 'Local Worker artifact path is outside the task output namespace';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.worker_artifact_path_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_artifact_path_guard() TO infinity_worker;

-- Row-level checks cannot see the complete claim transaction because the
-- normal claim path first leases the task, then creates the Attempt, event,
-- and Outbox rows. This deferred trigger validates the final transaction
-- image, so a direct Worker UPDATE cannot commit a partial lifecycle.
CREATE OR REPLACE FUNCTION app.worker_task_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  actor text;
  final_status text;
  final_attempt_id bigint;
  final_task_id uuid;
  expected_event text;
  expected_outbox text;
  transition_attempt_id bigint;
  transition_event_id bigint;
BEGIN
  actor := NULLIF(current_setting('app.worker_id', true), '');
  IF actor IS NULL OR app.current_worker_id() IS NULL THEN
    RETURN NEW;
  END IF;

  -- A claim changes the task row more than once in one transaction. Read the
  -- transaction's current final image instead of validating the first
  -- intermediate UPDATE (which intentionally has no active_attempt_id yet).
  SELECT t.status, t.active_attempt_id, t.task_id
  INTO final_status, final_attempt_id, final_task_id
  FROM tasks t
  WHERE t.task_id = NEW.task_id;
  IF final_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Lease renewal and harmless metadata updates do not create a new
  -- lifecycle transition. The status-changing cases below must have their
  -- durable rows before the transaction can commit.
  IF final_status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF final_status = 'claimed' THEN
    IF final_attempt_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM task_attempts a
      WHERE a.task_attempt_id = final_attempt_id
        AND a.task_id = final_task_id
        AND a.worker_id = actor
        AND a.status IN ('claimed', 'running')
    ) THEN
      RAISE EXCEPTION 'Worker claim must finish with an active Attempt';
    END IF;
    transition_attempt_id := final_attempt_id;
    expected_event := 'task_claimed';
    expected_outbox := 'task_claimed';
  ELSIF final_status = 'running' THEN
    IF final_attempt_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM task_attempts a
      WHERE a.task_attempt_id = final_attempt_id
        AND a.task_id = final_task_id
        AND a.worker_id = actor
        AND a.status = 'running'
    ) THEN
      RAISE EXCEPTION 'Worker running transition must retain an active Attempt';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM task_events e
      WHERE e.task_id = final_task_id
        AND e.task_attempt_id = final_attempt_id
        AND e.event_type = 'task_running'
    ) THEN
      RAISE EXCEPTION 'Worker running transition must emit a task event';
    END IF;
    RETURN NEW;
  ELSIF final_status IN ('succeeded', 'failed', 'cancelled', 'timeout') THEN
    IF final_attempt_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM task_attempts a
      WHERE a.task_attempt_id = final_attempt_id
        AND a.task_id = final_task_id
        AND a.worker_id = actor
        AND a.status IN ('succeeded', 'failed', 'cancelled', 'lost')
    ) THEN
      RAISE EXCEPTION 'Terminal Worker transition must complete its Attempt';
    END IF;
    transition_attempt_id := final_attempt_id;
    expected_event := 'task_' || final_status;
    expected_outbox := expected_event;
  ELSIF final_status = 'queued' THEN
    IF final_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'Requeued Worker task must release its active Attempt';
    END IF;
    IF OLD.active_attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM task_attempts a
      WHERE a.task_attempt_id = OLD.active_attempt_id
        AND a.task_id = final_task_id
        AND a.worker_id = actor
        AND a.status IN ('failed', 'cancelled', 'lost')
    ) THEN
      RAISE EXCEPTION 'Requeued Worker task must complete its previous Attempt';
    END IF;
    IF OLD.active_attempt_id IS NULL THEN
      RAISE EXCEPTION 'Requeued Worker task must identify its previous Attempt';
    END IF;
    transition_attempt_id := OLD.active_attempt_id;
    expected_event := 'task_requeued';
    expected_outbox := 'task_queued';
  ELSE
    RAISE EXCEPTION 'Worker transition is outside the task lifecycle';
  END IF;

  SELECT e.task_event_id
  INTO transition_event_id
  FROM task_events e
  WHERE e.task_id = final_task_id
    AND e.task_attempt_id = transition_attempt_id
    AND e.event_type = expected_event
  ORDER BY e.task_event_id DESC
  LIMIT 1;
  IF transition_event_id IS NULL THEN
    RAISE EXCEPTION 'Worker transition must emit its durable task event';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM outbox_events o
      WHERE o.aggregate_type = 'task'
      AND o.aggregate_id = final_task_id
      AND o.event_type = expected_outbox
      AND o.payload->>'task_event_id' = transition_event_id::text
  ) THEN
    RAISE EXCEPTION 'Worker transition must emit its durable Outbox event';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.worker_task_lifecycle_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.worker_uses_task_spec(target_spec uuid, actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.task_spec_id = target_spec
      AND t.lease_owner = actor
      AND app.worker_can_access_task(t.task_id, actor)
      AND t.status IN ('claimed', 'running')
      AND t.lease_expires_at > NOW()
  )
$$;

CREATE OR REPLACE FUNCTION app.worker_uses_dataset(target_dataset uuid, actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.dataset_snapshot_id = target_dataset
      AND t.lease_owner = actor
      AND app.worker_can_access_task(t.task_id, actor)
      AND t.status IN ('claimed', 'running')
      AND t.lease_expires_at > NOW()
  )
$$;

CREATE OR REPLACE FUNCTION app.worker_uses_method(target_method uuid, actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.method_source_id = target_method
      AND t.lease_owner = actor
      AND app.worker_can_access_task(t.task_id, actor)
      AND t.status IN ('claimed', 'running')
      AND t.lease_expires_at > NOW()
  )
$$;

REVOKE ALL ON FUNCTION app.worker_uses_task_spec(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.worker_uses_dataset(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.worker_uses_method(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_uses_task_spec(uuid, text) TO infinity_worker;
GRANT EXECUTE ON FUNCTION app.worker_uses_dataset(uuid, text) TO infinity_worker;
GRANT EXECUTE ON FUNCTION app.worker_uses_method(uuid, text) TO infinity_worker;

CREATE OR REPLACE FUNCTION app.worker_has_active_lease(target_task uuid, actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tasks t
    WHERE t.task_id = target_task
      AND t.lease_owner = actor
      AND t.status IN ('claimed', 'running')
      AND t.lease_expires_at > NOW()
  )
$$;
REVOKE ALL ON FUNCTION app.worker_has_active_lease(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_has_active_lease(uuid, text) TO infinity_worker;

-- Keep the legacy helper object for idempotent upgrades, but revoke it: all
-- active policies below use the attempt-bound helpers instead.
DO $$
BEGIN
  IF to_regprocedure('app.reaper_task_recovered(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app.reaper_task_recovered(uuid) FROM PUBLIC, infinity_reaper;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app.reaper_recovered_attempt(target_task uuid, target_attempt bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tasks t
    JOIN task_attempts a ON a.task_id = t.task_id
    WHERE t.task_id = target_task
      AND t.status IN ('queued', 'failed')
      AND t.lease_owner IS NULL
      AND t.lease_token IS NULL
      AND t.lease_expires_at IS NULL
      AND t.active_attempt_id IS NULL
      AND a.task_attempt_id = target_attempt
      AND a.status = 'lost'
      AND a.failure_code = 'lease_expired'
      AND a.finished_at >= NOW() - INTERVAL '10 minutes'
  )
$$;
REVOKE ALL ON FUNCTION app.reaper_recovered_attempt(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reaper_recovered_attempt(uuid, bigint) TO infinity_reaper;

CREATE OR REPLACE FUNCTION app.reaper_recovery_event_allowed(target_task uuid, target_attempt bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT app.reaper_recovered_attempt(target_task, target_attempt)
    AND NOT EXISTS (
      SELECT 1
      FROM task_events e
      WHERE e.task_id = target_task
        AND e.task_attempt_id = target_attempt
        AND e.event_type = 'attempt_lost'
    )
$$;
REVOKE ALL ON FUNCTION app.reaper_recovery_event_allowed(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reaper_recovery_event_allowed(uuid, bigint) TO infinity_reaper;

CREATE OR REPLACE FUNCTION app.reaper_recovery_outbox_visible(target_task uuid, target_event bigint, target_type text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT target_type IN ('task_queued', 'task_failed')
    AND app.reaper_recovered_attempt(target_task, (
      SELECT e.task_attempt_id
      FROM task_events e
      WHERE e.task_event_id = target_event
        AND e.task_id = target_task
        AND e.event_type = 'attempt_lost'
        AND COALESCE(e.event_data->>'reason', '') = 'lease_expired'
      LIMIT 1
    ))
$$;
REVOKE ALL ON FUNCTION app.reaper_recovery_outbox_visible(uuid, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reaper_recovery_outbox_visible(uuid, bigint, text) TO infinity_reaper;

CREATE OR REPLACE FUNCTION app.reaper_recovery_outbox_allowed(target_task uuid, target_event bigint, target_type text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT app.reaper_recovery_outbox_visible(target_task, target_event, target_type)
    AND NOT EXISTS (
      SELECT 1
      FROM outbox_events o
      WHERE o.aggregate_type = 'task'
        AND o.aggregate_id = target_task
        AND o.payload->>'task_event_id' = target_event::text
    )
$$;
REVOKE ALL ON FUNCTION app.reaper_recovery_outbox_allowed(uuid, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reaper_recovery_outbox_allowed(uuid, bigint, text) TO infinity_reaper;

CREATE OR REPLACE FUNCTION app.reaper_task_expired(target_task uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.task_id = target_task
      AND t.status IN ('claimed', 'running')
      AND t.lease_expires_at < NOW()
  )
$$;
REVOKE ALL ON FUNCTION app.reaper_task_expired(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reaper_task_expired(uuid) TO infinity_reaper;

CREATE OR REPLACE FUNCTION app.worker_trust_allows(required text, actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT required = 'general' OR EXISTS (
    SELECT 1
    FROM worker_enrollments w
    WHERE w.worker_id = actor
      AND w.status = 'active'
      AND w.revoked_at IS NULL
      AND w.trust_level = 'full'
  )
$$;
REVOKE ALL ON FUNCTION app.worker_trust_allows(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_trust_allows(text, text) TO infinity_worker;

-- The ordinary API role can only issue general-trust enrollments. Full trust
-- uses a separate NOLOGIN role that the controlled runtime login may SET ROLE
-- to for the duration of the server-derived superuser issuance call. A direct
-- connection as infinity_api cannot invoke the full-trust function.
DROP FUNCTION IF EXISTS app.issue_worker_enrollment(text, text, text, text, text);
CREATE OR REPLACE FUNCTION app.issue_worker_enrollment(
  p_worker_id text,
  p_credential_hash text,
  p_namespace text,
  p_owner_user_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  existing_owner text;
  existing_namespace text;
  existing_status text;
  existing_revoked_at timestamptz;
BEGIN
  IF p_owner_user_id IS NOT NULL THEN
    -- Serialize the account Namespace check with concurrent Worker issuance.
    -- Without this transaction-scoped lock, two simultaneous requests can
    -- both observe no active enrollment and commit different Namespaces.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_user_id, 0));
  END IF;
  IF p_owner_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Worker owner does not match the current API user';
  END IF;
  IF p_namespace IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('worker-namespace:' || p_namespace, 0));
    IF EXISTS (
      SELECT 1
      FROM worker_enrollments
      WHERE namespace = p_namespace
        AND owner_user_id IS NOT NULL
        AND owner_user_id IS DISTINCT FROM p_owner_user_id
    ) THEN
      RAISE EXCEPTION 'Worker Namespace is already bound to another user';
    END IF;
  END IF;
  SELECT owner_user_id, status, revoked_at
  INTO existing_owner, existing_status, existing_revoked_at
  FROM worker_enrollments
  WHERE worker_id = p_worker_id
  FOR UPDATE;
  IF existing_status = 'active' AND existing_revoked_at IS NULL THEN
    RAISE EXCEPTION 'Worker ID already has an active enrollment';
  END IF;
  IF existing_owner IS NOT NULL AND existing_owner IS DISTINCT FROM p_owner_user_id THEN
    RAISE EXCEPTION 'Worker is already owned by another user';
  END IF;
  IF p_owner_user_id IS NOT NULL THEN
    SELECT namespace INTO existing_namespace
    FROM worker_enrollments
    WHERE owner_user_id = p_owner_user_id
      AND status = 'active'
      AND namespace IS DISTINCT FROM p_namespace
    LIMIT 1;
    IF existing_namespace IS NOT NULL THEN
      RAISE EXCEPTION 'Account is already bound to another Worker Namespace';
    END IF;
  END IF;
  UPDATE worker_enrollments
  SET credential_hash = p_credential_hash,
      namespace = p_namespace,
      owner_user_id = p_owner_user_id,
      trust_level = 'general',
      status = 'active',
      enrolled_at = NOW(),
      revoked_at = NULL,
      last_seen_at = NOW()
  WHERE worker_id = p_worker_id;
  IF NOT FOUND THEN
    INSERT INTO worker_enrollments (
      worker_id, credential_hash, namespace, owner_user_id, trust_level,
      status, last_seen_at
    ) VALUES (
      p_worker_id, p_credential_hash, p_namespace, p_owner_user_id,
      'general', 'active', NOW()
    );
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.issue_worker_enrollment(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.issue_worker_enrollment(text, text, text, text) TO infinity_api;

-- Public-pool issuance keeps the signed-in user as the audit owner, but does
-- not bind the shared server Namespace to that user.  Scheduling access is a
-- separate server-owned execution_pool decision; this function only creates
-- one unique credential and starts it in the incompatible/not-ready state
-- until the new Worker protocol handshake completes.
CREATE OR REPLACE FUNCTION app.issue_public_worker_enrollment(
  p_worker_id text,
  p_credential_hash text,
  p_namespace text,
  p_owner_user_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  existing_owner text;
  existing_status text;
  existing_revoked_at timestamptz;
BEGIN
  IF p_owner_user_id IS NULL OR p_owner_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Worker issuer owner does not match the current API user';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('worker-namespace:' || p_namespace, 0));
  SELECT owner_user_id, status, revoked_at
  INTO existing_owner, existing_status, existing_revoked_at
  FROM worker_enrollments
  WHERE worker_id = p_worker_id
  FOR UPDATE;
  IF existing_status = 'active' AND existing_revoked_at IS NULL THEN
    RAISE EXCEPTION 'Worker ID already has an active enrollment';
  END IF;
  IF existing_owner IS NOT NULL AND existing_owner IS DISTINCT FROM p_owner_user_id THEN
    RAISE EXCEPTION 'Worker is already owned by another account';
  END IF;
  UPDATE worker_enrollments
  SET credential_hash = p_credential_hash,
      namespace = p_namespace,
      owner_user_id = p_owner_user_id,
      execution_pool = 'public-default',
      trust_level = 'general',
      protocol_version = 'legacy-v0',
      runtime_capability = 'legacy',
      image_digest = NULL,
      active_instance_id = NULL,
      active_instance_expires_at = NULL,
      session_epoch = session_epoch + 1,
      ready = FALSE,
      last_error = NULL,
      connected_at = NULL,
      status = 'active',
      enrolled_at = NOW(),
      revoked_at = NULL,
      last_seen_at = NOW()
  WHERE worker_id = p_worker_id;
  IF NOT FOUND THEN
    INSERT INTO worker_enrollments (
      worker_id, credential_hash, namespace, owner_user_id, execution_pool,
      trust_level, protocol_version, runtime_capability, ready, status, last_seen_at
    ) VALUES (
      p_worker_id, p_credential_hash, p_namespace, p_owner_user_id,
      'public-default', 'general', 'legacy-v0', 'legacy', FALSE, 'active', NOW()
    );
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.issue_public_worker_enrollment(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.issue_public_worker_enrollment(text, text, text, text) TO infinity_api;

CREATE OR REPLACE FUNCTION app.issue_full_worker_enrollment(
  p_worker_id text,
  p_credential_hash text,
  p_namespace text,
  p_owner_user_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  existing_owner text;
  existing_namespace text;
  existing_status text;
  existing_revoked_at timestamptz;
BEGIN
  IF p_owner_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_user_id, 0));
  END IF;
  IF p_owner_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Worker owner does not match the current API user';
  END IF;
  IF p_namespace IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('worker-namespace:' || p_namespace, 0));
    IF EXISTS (
      SELECT 1
      FROM worker_enrollments
      WHERE namespace = p_namespace
        AND owner_user_id IS NOT NULL
        AND owner_user_id IS DISTINCT FROM p_owner_user_id
    ) THEN
      RAISE EXCEPTION 'Worker Namespace is already bound to another user';
    END IF;
  END IF;
  SELECT owner_user_id, status, revoked_at
  INTO existing_owner, existing_status, existing_revoked_at
  FROM worker_enrollments
  WHERE worker_id = p_worker_id
  FOR UPDATE;
  IF existing_status = 'active' AND existing_revoked_at IS NULL THEN
    RAISE EXCEPTION 'Worker ID already has an active enrollment';
  END IF;
  IF existing_owner IS NOT NULL AND existing_owner IS DISTINCT FROM p_owner_user_id THEN
    RAISE EXCEPTION 'Worker is already owned by another user';
  END IF;
  IF p_owner_user_id IS NOT NULL THEN
    SELECT namespace INTO existing_namespace
    FROM worker_enrollments
    WHERE owner_user_id = p_owner_user_id
      AND status = 'active'
      AND namespace IS DISTINCT FROM p_namespace
    LIMIT 1;
    IF existing_namespace IS NOT NULL THEN
      RAISE EXCEPTION 'Account is already bound to another Worker Namespace';
    END IF;
  END IF;
  UPDATE worker_enrollments
  SET credential_hash = p_credential_hash,
      namespace = p_namespace,
      owner_user_id = p_owner_user_id,
      trust_level = 'full',
      status = 'active',
      enrolled_at = NOW(),
      revoked_at = NULL,
      last_seen_at = NOW()
  WHERE worker_id = p_worker_id;
  IF NOT FOUND THEN
    INSERT INTO worker_enrollments (
      worker_id, credential_hash, namespace, owner_user_id, trust_level,
      status, last_seen_at
    ) VALUES (
      p_worker_id, p_credential_hash, p_namespace, p_owner_user_id,
      'full', 'active', NOW()
    );
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.issue_full_worker_enrollment(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.issue_full_worker_enrollment(text, text, text, text) TO infinity_trust_issuer;

-- Revoke is an operator action. The HTTP layer checks the authenticated
-- operator, while the database capability is held by the dedicated trust
-- issuer login rather than the ordinary API role.
CREATE OR REPLACE FUNCTION app.revoke_worker_enrollment(
  p_worker_id text,
  p_namespace text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  UPDATE worker_enrollments
  SET status = 'revoked', revoked_at = NOW(), ready = FALSE,
      active_instance_id = NULL, active_instance_expires_at = NULL,
      last_error = 'Worker credential revoked'
  WHERE worker_id = p_worker_id
    AND namespace = p_namespace
    AND status = 'active';
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION app.revoke_worker_enrollment(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.revoke_worker_enrollment(text, text) FROM infinity_api;
GRANT EXECUTE ON FUNCTION app.revoke_worker_enrollment(text, text) TO infinity_trust_issuer;

-- Cross-project references are part of the ownership boundary. NOT VALID lets
-- an operator install the policy on a legacy DB, then repair and VALIDATE the
-- constraints as a separately auditable migration step.
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_specs_project_id
  ON task_specs (project_id, task_spec_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_snapshots_project_id
  ON dataset_snapshots (project_id, dataset_snapshot_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_method_sources_project_id
  ON method_sources (project_id, method_source_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.task_specs'::regclass AND conname = 'fk_task_specs_project_security') THEN
    ALTER TABLE task_specs
      ADD CONSTRAINT fk_task_specs_project_security
      FOREIGN KEY (project_id) REFERENCES projects(project_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dataset_snapshots'::regclass AND conname = 'fk_dataset_snapshots_project_spec_security') THEN
    ALTER TABLE dataset_snapshots
      ADD CONSTRAINT fk_dataset_snapshots_project_spec_security
      FOREIGN KEY (project_id, task_spec_id)
      REFERENCES task_specs(project_id, task_spec_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND conname = 'fk_tasks_project_spec_security') THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_project_spec_security
      FOREIGN KEY (project_id, task_spec_id)
      REFERENCES task_specs(project_id, task_spec_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND conname = 'fk_tasks_project_dataset_security') THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_project_dataset_security
      FOREIGN KEY (project_id, dataset_snapshot_id)
      REFERENCES dataset_snapshots(project_id, dataset_snapshot_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_members'::regclass AND conname = 'fk_project_members_user_security') THEN
    ALTER TABLE project_members
      ADD CONSTRAINT fk_project_members_user_security
      FOREIGN KEY (user_id) REFERENCES users(user_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.project_resources'::regclass AND conname = 'fk_project_resources_member_security') THEN
    ALTER TABLE project_resources
      ADD CONSTRAINT fk_project_resources_member_security
      FOREIGN KEY (project_id, owner_user_id)
      REFERENCES project_members(project_id, user_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.provider_profiles'::regclass AND conname = 'fk_provider_profiles_member_security') THEN
    ALTER TABLE provider_profiles
      ADD CONSTRAINT fk_provider_profiles_member_security
      FOREIGN KEY (project_id, owner_user_id)
      REFERENCES project_members(project_id, user_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.provider_secrets'::regclass AND conname = 'fk_provider_secrets_member_security') THEN
    ALTER TABLE provider_secrets
      ADD CONSTRAINT fk_provider_secrets_member_security
      FOREIGN KEY (project_id, owner_user_id)
      REFERENCES project_members(project_id, user_id) NOT VALID;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO infinity_api, infinity_worker, infinity_outbox;
GRANT USAGE ON SCHEMA app TO infinity_trust_issuer;
GRANT USAGE ON SCHEMA public, app TO infinity_reaper;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO infinity_api, infinity_worker, infinity_outbox;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO infinity_reaper;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, auth_sessions, project_members, projects, task_specs, method_sources,
  dataset_snapshots, tasks, task_attempts, task_events, outbox_events,
  artifacts, idempotency_keys, project_resources, session_resource_links,
  provider_profiles, provider_secrets
TO infinity_api;
-- Enrollment trust is server-derived.  The ordinary API role may create or
-- rotate an enrollment, but it cannot supply or mutate trust_level through
-- direct SQL; the protected issuance function below is the only RLS path that
-- writes that column.
GRANT SELECT, DELETE ON worker_enrollments TO infinity_api;
GRANT INSERT (
  worker_id, credential_hash, namespace, owner_user_id, status,
  enrolled_at, revoked_at, last_seen_at
) ON worker_enrollments TO infinity_api;
GRANT UPDATE (
  credential_hash, namespace, owner_user_id, status, enrolled_at,
  revoked_at, last_seen_at
) ON worker_enrollments TO infinity_api;
GRANT SELECT, DELETE ON worker_enrollment_tokens TO infinity_api;
GRANT INSERT (
  token_hash, worker_id, namespace, owner_user_id, expires_at, created_at
) ON worker_enrollment_tokens TO infinity_api;
GRANT UPDATE (used_at) ON worker_enrollment_tokens TO infinity_api;

-- Workers can only change the lease/state columns needed by the executor.
-- Immutable task inputs, ownership, and required trust are never writable by
-- the Worker database role, even if its process is compromised.
GRANT SELECT, DELETE ON artifacts TO infinity_worker;
GRANT SELECT ON tasks, task_attempts, task_events TO infinity_worker;
GRANT UPDATE (
  status, phase, lease_owner, lease_token, lease_expires_at, active_attempt_id,
  attempt_count, result_artifact_id, error_message,
  updated_at, started_at, finished_at, next_attempt_at
) ON tasks TO infinity_worker;
GRANT INSERT (task_id, worker_id, status, attempt_index, started_at), UPDATE (
  status, finished_at, exit_code, error_message, executor_image_digest,
  failure_code, failure_detail, token_usage
) ON task_attempts TO infinity_worker;
GRANT INSERT (task_id, task_attempt_id, event_type, event_data, created_at)
  ON task_events TO infinity_worker;
GRANT INSERT (
  artifact_id, task_id, task_attempt_id, name, kind, storage_backend,
  storage_path, file_size_bytes, checksum_sha256, content_type, metadata,
  created_at
) ON artifacts TO infinity_worker;
GRANT SELECT ON task_specs, dataset_snapshots, method_sources TO infinity_worker;
GRANT SELECT ON worker_enrollments TO infinity_worker;
GRANT UPDATE (last_seen_at) ON worker_enrollments TO infinity_worker;
GRANT INSERT (
  aggregate_type, aggregate_id, event_type, payload, status,
  next_attempt_at, created_at
) ON outbox_events TO infinity_worker;
REVOKE ALL ON sessions, messages, paper_records, paper_records_global,
  authorized_paper_refs, session_paper_links, session_uploaded_papers,
  paper_cache, paper_cache_global, session_tool_calls,
  session_context_compression
FROM infinity_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  oauth_states, sessions, messages, paper_records, paper_records_global,
  authorized_paper_refs, session_paper_links, session_uploaded_papers,
  paper_cache, paper_cache_global, session_tool_calls,
  session_context_compression
TO infinity_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events TO infinity_outbox;

-- Lease recovery is a separate internal capability. It can see and mutate
-- only expired leased tasks and the recovery rows produced from them; it is
-- never granted to a data-plane Worker.
GRANT SELECT ON tasks, task_attempts TO infinity_reaper;
GRANT UPDATE (
  status, lease_owner, lease_token, lease_expires_at, active_attempt_id,
  next_attempt_at, error_message, finished_at, updated_at
) ON tasks TO infinity_reaper;
GRANT UPDATE (status, finished_at, error_message, failure_code) ON task_attempts TO infinity_reaper;
GRANT SELECT ON artifacts TO infinity_reaper;
GRANT UPDATE (deleted_at, cleanup_completed_at) ON artifacts TO infinity_reaper;
GRANT INSERT (task_id, worker_id, status, attempt_index, started_at, finished_at,
  error_message, failure_code) ON task_attempts TO infinity_reaper;
GRANT INSERT (task_id, task_attempt_id, event_type, event_data, created_at)
  ON task_events TO infinity_reaper;
GRANT SELECT (task_event_id) ON task_events TO infinity_reaper;
GRANT INSERT (
  aggregate_type, aggregate_id, event_type, payload, status,
  next_attempt_at, created_at
) ON outbox_events TO infinity_reaper;
GRANT SELECT (outbox_event_id) ON outbox_events TO infinity_reaper;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users', 'auth_sessions', 'oauth_states', 'sessions', 'messages',
    'paper_records', 'authorized_paper_refs', 'session_paper_links',
    'session_uploaded_papers', 'paper_cache', 'session_tool_calls',
    'session_context_compression',
    'projects', 'project_members', 'task_specs', 'method_sources',
    'dataset_snapshots', 'tasks', 'task_attempts', 'task_events',
    'outbox_events', 'artifacts', 'idempotency_keys', 'project_resources',
    'session_resource_links', 'provider_profiles', 'provider_secrets',
    'worker_enrollments', 'worker_enrollment_tokens'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;

-- Authentication, chat, and paper-session rows are user scoped as well.  A
-- database login must not be able to bypass the application-level session
-- checks by issuing direct SQL through the API connection pool.
DROP POLICY IF EXISTS users_self_policy ON users;
CREATE POLICY users_self_policy ON users
  FOR ALL TO infinity_api
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

DROP POLICY IF EXISTS auth_sessions_self_policy ON auth_sessions;
CREATE POLICY auth_sessions_self_policy ON auth_sessions
  FOR ALL TO infinity_api
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

DROP POLICY IF EXISTS oauth_states_auth_flow_policy ON oauth_states;
CREATE POLICY oauth_states_auth_flow_policy ON oauth_states
  FOR ALL TO infinity_api
  USING (app.current_user_id() = 'auth-flow')
  WITH CHECK (app.current_user_id() = 'auth-flow');

DROP POLICY IF EXISTS sessions_self_policy ON sessions;
CREATE POLICY sessions_self_policy ON sessions
  FOR ALL TO infinity_api
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

DROP POLICY IF EXISTS messages_session_owner_policy ON messages;
CREATE POLICY messages_session_owner_policy ON messages
  FOR ALL TO infinity_api
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = messages.session_id
      AND s.user_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = messages.session_id
      AND s.user_id = app.current_user_id()
  ));

DROP POLICY IF EXISTS paper_records_session_owner_policy ON paper_records;
CREATE POLICY paper_records_session_owner_policy ON paper_records
  FOR ALL TO infinity_api
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = paper_records.session_id
      AND s.user_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = paper_records.session_id
      AND s.user_id = app.current_user_id()
  ));

DROP POLICY IF EXISTS authorized_paper_refs_session_owner_policy ON authorized_paper_refs;
CREATE POLICY authorized_paper_refs_session_owner_policy ON authorized_paper_refs
  FOR ALL TO infinity_api
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = authorized_paper_refs.session_id
      AND s.user_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = authorized_paper_refs.session_id
      AND s.user_id = app.current_user_id()
  ));

DROP POLICY IF EXISTS session_paper_links_owner_policy ON session_paper_links;
CREATE POLICY session_paper_links_owner_policy ON session_paper_links
  FOR ALL TO infinity_api
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = session_paper_links.session_id
      AND s.user_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = session_paper_links.session_id
      AND s.user_id = app.current_user_id()
  ));

DROP POLICY IF EXISTS session_uploaded_papers_owner_policy ON session_uploaded_papers;
CREATE POLICY session_uploaded_papers_owner_policy ON session_uploaded_papers
  FOR ALL TO infinity_api
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = session_uploaded_papers.session_id
      AND s.user_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = session_uploaded_papers.session_id
      AND s.user_id = app.current_user_id()
  ));

DROP POLICY IF EXISTS paper_cache_session_owner_policy ON paper_cache;
CREATE POLICY paper_cache_session_owner_policy ON paper_cache
  FOR ALL TO infinity_api
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = paper_cache.session_id
      AND s.user_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = paper_cache.session_id
      AND s.user_id = app.current_user_id()
  ));

DROP POLICY IF EXISTS session_tool_calls_owner_policy ON session_tool_calls;
CREATE POLICY session_tool_calls_owner_policy ON session_tool_calls
  FOR ALL TO infinity_api
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = session_tool_calls.session_id
      AND s.user_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = session_tool_calls.session_id
      AND s.user_id = app.current_user_id()
  ));

DROP POLICY IF EXISTS session_context_compression_owner_policy ON session_context_compression;
CREATE POLICY session_context_compression_owner_policy ON session_context_compression
  FOR ALL TO infinity_api
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = session_context_compression.session_id
      AND s.user_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.session_id = session_context_compression.session_id
      AND s.user_id = app.current_user_id()
  ));

DROP POLICY IF EXISTS projects_member_policy ON projects;
CREATE POLICY projects_member_policy ON projects
  FOR ALL TO infinity_api
  USING (app.project_access(project_id, app.current_user_id()))
  WITH CHECK (owner_user_id = app.current_user_id());

DROP POLICY IF EXISTS project_members_self_policy ON project_members;
CREATE POLICY project_members_self_policy ON project_members
  FOR ALL TO infinity_api
  USING (user_id = app.current_user_id()
         OR app.project_access(project_id, app.current_user_id()))
  WITH CHECK (user_id = app.current_user_id()
              OR app.project_access(project_id, app.current_user_id()));

DROP POLICY IF EXISTS task_project_member_policy ON task_specs;
CREATE POLICY task_project_member_policy ON task_specs
  FOR ALL TO infinity_api
  USING (app.project_access(project_id, app.current_user_id()))
  WITH CHECK (app.project_access(project_id, app.current_user_id()));

DROP POLICY IF EXISTS task_spec_worker_policy ON task_specs;
CREATE POLICY task_spec_worker_policy ON task_specs
  FOR SELECT TO infinity_worker
  USING (app.worker_uses_task_spec(task_spec_id, app.current_worker_id()));

DROP POLICY IF EXISTS method_project_member_policy ON method_sources;
CREATE POLICY method_project_member_policy ON method_sources
  FOR ALL TO infinity_api
  USING (app.project_access(project_id, app.current_user_id()))
  WITH CHECK (app.project_access(project_id, app.current_user_id()));

DROP POLICY IF EXISTS method_worker_policy ON method_sources;
CREATE POLICY method_worker_policy ON method_sources
  FOR SELECT TO infinity_worker
  USING (app.worker_uses_method(method_source_id, app.current_worker_id()));

DROP POLICY IF EXISTS dataset_project_member_policy ON dataset_snapshots;
CREATE POLICY dataset_project_member_policy ON dataset_snapshots
  FOR ALL TO infinity_api
  USING (app.project_access(project_id, app.current_user_id()))
  WITH CHECK (app.project_access(project_id, app.current_user_id()));

DROP POLICY IF EXISTS dataset_worker_policy ON dataset_snapshots;
CREATE POLICY dataset_worker_policy ON dataset_snapshots
  FOR SELECT TO infinity_worker
  USING (app.worker_uses_dataset(dataset_snapshot_id, app.current_worker_id()));

DROP POLICY IF EXISTS task_project_member_policy ON tasks;
CREATE POLICY task_project_member_policy ON tasks
  FOR ALL TO infinity_api
  USING (app.project_access(project_id, app.current_user_id()))
  WITH CHECK (app.project_access(project_id, app.current_user_id()));

DROP POLICY IF EXISTS attempt_worker_policy ON task_attempts;
CREATE POLICY attempt_worker_policy ON task_attempts
  FOR ALL TO infinity_worker
  USING (worker_id = app.current_worker_id()
         AND app.worker_has_active_lease(task_id, app.current_worker_id()))
  WITH CHECK (worker_id = app.current_worker_id()
              AND app.worker_has_active_lease(task_id, app.current_worker_id()));

DROP POLICY IF EXISTS task_worker_policy ON tasks;
CREATE POLICY task_worker_policy ON tasks
  FOR ALL TO infinity_worker
  USING ((status = 'queued' AND app.worker_trust_allows(required_trust_level, app.current_worker_id())
         AND app.worker_can_access_task(task_id, app.current_worker_id()))
         -- This direct predicate is evaluated against both sides of an
         -- UPDATE by PostgreSQL RLS.  It therefore permits the new active
         -- lease created by a CAS claim while rejecting expired owners.
         OR (lease_owner = app.current_worker_id()
             AND status IN ('claimed', 'running', 'succeeded', 'failed', 'cancelled', 'timeout')
             AND lease_expires_at > NOW()))
  WITH CHECK (
    (status = 'queued' AND app.worker_trust_allows(required_trust_level, app.current_worker_id())
     AND app.worker_can_access_task(task_id, app.current_worker_id()))
    -- WITH CHECK evaluates the new row.  The helper intentionally reads the
    -- old committed version, so a claim must validate the new lease fields
    -- directly while still requiring the credential-bound Worker identity.
    OR (lease_owner = app.current_worker_id()
        AND status IN ('claimed', 'running', 'succeeded', 'failed', 'cancelled', 'timeout')
        AND lease_expires_at > NOW()
        AND app.worker_can_access_task(task_id, app.current_worker_id()))
    -- Keep the lease marker on the terminal row until natural expiry.  The
    -- data-plane policies below still require claimed/running, while this
    -- active marker lets the same Worker complete the state transition.
    OR app.worker_has_active_lease(task_id, app.current_worker_id())
    OR (status IN ('succeeded', 'failed', 'cancelled', 'timeout')
        AND active_attempt_id IS NOT NULL
        AND lease_owner = app.current_worker_id()
        AND lease_expires_at > NOW()
        AND app.worker_can_access_task(task_id, app.current_worker_id()))
  );

DROP POLICY IF EXISTS worker_enrollment_api_policy ON worker_enrollments;
CREATE POLICY worker_enrollment_api_policy ON worker_enrollments
  FOR ALL TO infinity_api
  USING (owner_user_id = app.current_user_id())
  WITH CHECK (owner_user_id = app.current_user_id());

DROP POLICY IF EXISTS worker_enrollment_worker_select_policy ON worker_enrollments;
CREATE POLICY worker_enrollment_worker_select_policy ON worker_enrollments
  FOR SELECT TO infinity_worker
  USING (worker_id = app.current_worker_id());

DROP POLICY IF EXISTS worker_enrollment_worker_heartbeat_policy ON worker_enrollments;
CREATE POLICY worker_enrollment_worker_heartbeat_policy ON worker_enrollments
  FOR UPDATE TO infinity_worker
  USING (worker_id = app.current_worker_id())
  WITH CHECK (worker_id = app.current_worker_id());

DROP POLICY IF EXISTS worker_enrollment_token_api_policy ON worker_enrollment_tokens;
CREATE POLICY worker_enrollment_token_api_policy ON worker_enrollment_tokens
  FOR ALL TO infinity_api
  USING (owner_user_id = app.current_user_id())
  WITH CHECK (owner_user_id = app.current_user_id());

DROP POLICY IF EXISTS event_worker_policy ON task_events;
CREATE POLICY event_worker_policy ON task_events
  FOR ALL TO infinity_worker
  USING (app.worker_has_active_lease(task_events.task_id, app.current_worker_id()))
  WITH CHECK (app.worker_has_active_lease(task_events.task_id, app.current_worker_id()));

DROP POLICY IF EXISTS artifact_worker_policy ON artifacts;
CREATE POLICY artifact_worker_policy ON artifacts
  FOR ALL TO infinity_worker
  USING (artifacts.deleted_at IS NULL
         AND app.worker_has_active_lease(artifacts.task_id, app.current_worker_id())
         AND EXISTS (SELECT 1 FROM task_attempts a
                     WHERE a.task_attempt_id = artifacts.task_attempt_id
                       AND a.task_id = artifacts.task_id
                       AND a.worker_id = app.current_worker_id()))
  WITH CHECK (artifacts.deleted_at IS NULL
              AND app.worker_has_active_lease(artifacts.task_id, app.current_worker_id())
              AND EXISTS (SELECT 1 FROM task_attempts a
                          WHERE a.task_attempt_id = artifacts.task_attempt_id
                            AND a.task_id = artifacts.task_id
                            AND a.worker_id = app.current_worker_id()));

DROP POLICY IF EXISTS task_attempt_api_policy ON task_attempts;
CREATE POLICY task_attempt_api_policy ON task_attempts
  FOR ALL TO infinity_api
  USING (EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                 ON pm.project_id = t.project_id
                WHERE t.task_id = task_attempts.task_id
                  AND pm.user_id = app.current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                      ON pm.project_id = t.project_id
                     WHERE t.task_id = task_attempts.task_id
                       AND pm.user_id = app.current_user_id()));

DROP POLICY IF EXISTS task_event_api_policy ON task_events;
CREATE POLICY task_event_api_policy ON task_events
  FOR ALL TO infinity_api
  USING (EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                 ON pm.project_id = t.project_id
                WHERE t.task_id = task_events.task_id
                  AND pm.user_id = app.current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                      ON pm.project_id = t.project_id
                     WHERE t.task_id = task_events.task_id
                       AND pm.user_id = app.current_user_id()));

DROP POLICY IF EXISTS artifact_api_policy ON artifacts;
CREATE POLICY artifact_api_policy ON artifacts
  FOR ALL TO infinity_api
  USING (artifacts.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                 ON pm.project_id = t.project_id
                WHERE t.task_id = artifacts.task_id
                  AND pm.user_id = app.current_user_id()))
  WITH CHECK (artifacts.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                      ON pm.project_id = t.project_id
                     WHERE t.task_id = artifacts.task_id
                       AND pm.user_id = app.current_user_id()));

DROP POLICY IF EXISTS outbox_api_policy ON outbox_events;
CREATE POLICY outbox_api_policy ON outbox_events
  FOR ALL TO infinity_api
  USING (EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                 ON pm.project_id = t.project_id
                WHERE t.task_id = outbox_events.aggregate_id
                  AND pm.user_id = app.current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                      ON pm.project_id = t.project_id
                WHERE t.task_id = outbox_events.aggregate_id
                  AND pm.user_id = app.current_user_id()));

DROP POLICY IF EXISTS outbox_worker_policy ON outbox_events;
CREATE POLICY outbox_worker_policy ON outbox_events
  FOR INSERT TO infinity_worker
  WITH CHECK (app.worker_has_active_lease(outbox_events.aggregate_id, app.current_worker_id()));

DROP POLICY IF EXISTS outbox_service_policy ON outbox_events;
CREATE POLICY outbox_service_policy ON outbox_events
  FOR ALL TO infinity_outbox
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS task_reaper_policy ON tasks;
CREATE POLICY task_reaper_policy ON tasks
  FOR ALL TO infinity_reaper
  -- Only the old active lease is an eligible UPDATE target. A recovered
  -- queued/failed row is intentionally not updateable by the Reaper; the
  -- recovered helper below exists only for durable recovery notifications.
  USING (app.reaper_task_expired(task_id))
  WITH CHECK (
    status IN ('queued', 'failed')
    AND lease_owner IS NULL
    AND lease_token IS NULL
    AND lease_expires_at IS NULL
    AND active_attempt_id IS NULL
  );

DROP TRIGGER IF EXISTS tasks_worker_update_guard ON tasks;
CREATE TRIGGER tasks_worker_update_guard
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION app.worker_task_update_guard();

DROP TRIGGER IF EXISTS artifacts_worker_path_guard ON artifacts;
CREATE TRIGGER artifacts_worker_path_guard
  BEFORE INSERT OR UPDATE ON artifacts
  FOR EACH ROW
  EXECUTE FUNCTION app.worker_artifact_path_guard();

DROP TRIGGER IF EXISTS tasks_worker_lifecycle_guard ON tasks;
CREATE CONSTRAINT TRIGGER tasks_worker_lifecycle_guard
  AFTER UPDATE ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION app.worker_task_lifecycle_guard();

DROP POLICY IF EXISTS attempt_reaper_policy ON task_attempts;
CREATE POLICY attempt_reaper_policy ON task_attempts
  FOR UPDATE TO infinity_reaper
  USING (app.reaper_task_expired(task_attempts.task_id))
  WITH CHECK (status = 'lost' AND app.reaper_task_expired(task_attempts.task_id));

-- UPDATE and INSERT ... RETURNING need an explicit visibility policy as
-- well; otherwise PostgreSQL can silently find zero expired attempts or
-- reject the returned event row even though the write policy is correct.
DROP POLICY IF EXISTS attempt_reaper_select_policy ON task_attempts;
CREATE POLICY attempt_reaper_select_policy ON task_attempts
  FOR SELECT TO infinity_reaper
  USING (app.reaper_task_expired(task_attempts.task_id));

DROP POLICY IF EXISTS attempt_reaper_insert_policy ON task_attempts;
CREATE POLICY attempt_reaper_insert_policy ON task_attempts
  FOR INSERT TO infinity_reaper
  WITH CHECK (
    status = 'lost'
    AND failure_code = 'lease_expired'
    AND app.reaper_task_expired(task_attempts.task_id)
  );

-- A lease can expire after an artifact upload but before the final Task
-- transition. The Reaper removes that Attempt's artifact metadata as part of
-- the recovery transaction; physical local-file cleanup is constrained by the
-- Reaper process to the configured artifact roots.
DROP POLICY IF EXISTS artifact_reaper_policy ON artifacts;
CREATE POLICY artifact_reaper_policy ON artifacts
  FOR UPDATE TO infinity_reaper
  USING (
    (artifacts.deleted_at IS NULL AND app.reaper_task_expired(artifacts.task_id))
    OR (artifacts.deleted_at IS NOT NULL AND artifacts.cleanup_completed_at IS NULL)
  )
  WITH CHECK (artifacts.deleted_at IS NOT NULL);

DROP POLICY IF EXISTS artifact_reaper_select_policy ON artifacts;
CREATE POLICY artifact_reaper_select_policy ON artifacts
  FOR SELECT TO infinity_reaper
  USING (
    app.reaper_task_expired(artifacts.task_id)
    OR (artifacts.deleted_at IS NOT NULL AND artifacts.cleanup_completed_at IS NULL)
  );

DROP POLICY IF EXISTS event_reaper_policy ON task_events;
CREATE POLICY event_reaper_policy ON task_events
  FOR INSERT TO infinity_reaper
  WITH CHECK (
    event_type = 'attempt_lost'
    AND task_attempt_id IS NOT NULL
    AND COALESCE(event_data->>'reason', '') = 'lease_expired'
    AND app.reaper_recovery_event_allowed(task_events.task_id, task_events.task_attempt_id)
  );
DROP POLICY IF EXISTS event_reaper_select_policy ON task_events;
CREATE POLICY event_reaper_select_policy ON task_events
  FOR SELECT TO infinity_reaper
  USING (
    event_type = 'attempt_lost'
    AND task_attempt_id IS NOT NULL
    AND COALESCE(event_data->>'reason', '') = 'lease_expired'
    AND app.reaper_recovered_attempt(task_events.task_id, task_events.task_attempt_id)
  );

DROP POLICY IF EXISTS outbox_reaper_policy ON outbox_events;
CREATE POLICY outbox_reaper_policy ON outbox_events
  FOR INSERT TO infinity_reaper
  WITH CHECK (
    aggregate_type = 'task'
    AND event_type IN ('task_queued', 'task_failed')
    AND COALESCE(payload->>'reason', '') = 'lease_expired'
    AND NULLIF(payload->>'task_event_id', '') IS NOT NULL
    AND payload->>'task_event_id' ~ '^[0-9]+$'
    AND app.reaper_recovery_outbox_allowed(
      outbox_events.aggregate_id,
      (payload->>'task_event_id')::bigint,
      outbox_events.event_type
    )
  );
DROP POLICY IF EXISTS outbox_reaper_select_policy ON outbox_events;
CREATE POLICY outbox_reaper_select_policy ON outbox_events
  FOR SELECT TO infinity_reaper
  USING (
    aggregate_type = 'task'
    AND event_type IN ('task_queued', 'task_failed')
    AND COALESCE(payload->>'reason', '') = 'lease_expired'
    AND payload->>'task_event_id' ~ '^[0-9]+$'
    AND app.reaper_recovery_outbox_visible(
      outbox_events.aggregate_id,
      (payload->>'task_event_id')::bigint,
      outbox_events.event_type
    )
  );

DROP POLICY IF EXISTS idempotency_api_policy ON idempotency_keys;
CREATE POLICY idempotency_api_policy ON idempotency_keys
  FOR ALL TO infinity_api
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

DROP POLICY IF EXISTS resource_project_member_policy ON project_resources;
CREATE POLICY resource_project_member_policy ON project_resources
  FOR ALL TO infinity_api
  USING (owner_user_id = app.current_user_id()
         AND app.project_access(project_id, app.current_user_id()))
  WITH CHECK (owner_user_id = app.current_user_id());

DROP POLICY IF EXISTS session_resource_link_api_policy ON session_resource_links;
CREATE POLICY session_resource_link_api_policy ON session_resource_links
  FOR ALL TO infinity_api
  USING (EXISTS (
           SELECT 1
           FROM sessions s
           JOIN project_resources r ON r.resource_id = session_resource_links.resource_id
           WHERE s.session_id = session_resource_links.session_id
             AND s.user_id = app.current_user_id()
             AND r.owner_user_id = app.current_user_id()
         ))
  WITH CHECK (EXISTS (
           SELECT 1
           FROM sessions s
           JOIN project_resources r ON r.resource_id = session_resource_links.resource_id
           WHERE s.session_id = session_resource_links.session_id
             AND s.user_id = app.current_user_id()
             AND r.owner_user_id = app.current_user_id()
         ));

DROP POLICY IF EXISTS provider_profile_owner_policy ON provider_profiles;
CREATE POLICY provider_profile_owner_policy ON provider_profiles
  FOR ALL TO infinity_api
  USING (owner_user_id = app.current_user_id())
  WITH CHECK (owner_user_id = app.current_user_id());

DROP POLICY IF EXISTS provider_secret_owner_policy ON provider_secrets;
CREATE POLICY provider_secret_owner_policy ON provider_secrets
  FOR ALL TO infinity_api
  USING (owner_user_id = app.current_user_id())
  WITH CHECK (owner_user_id = app.current_user_id());

COMMIT;
