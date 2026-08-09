-- PostgreSQL security profile for a clean local acceptance database.
-- Run as a database owner/administrator, never from the API process:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rls_roles.sql
--
-- The application must set LOCAL app.user_id inside each request transaction;
-- the Worker must set LOCAL app.worker_id. An unset context is intentionally
-- denied by every policy. This script is not applied automatically because an
-- existing database may still contain legacy rows that need an explicit
-- migration review.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinity_api') THEN
    CREATE ROLE infinity_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinity_worker') THEN
    CREATE ROLE infinity_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

CREATE OR REPLACE FUNCTION app.current_worker_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.worker_id', true), '') $$;

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

-- Cross-project references are part of the ownership boundary. NOT VALID lets
-- an operator install the policy on a legacy DB, then repair and VALIDATE the
-- constraints as a separately auditable migration step.
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_specs_project_id
  ON task_specs (project_id, task_spec_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_snapshots_project_id
  ON dataset_snapshots (project_id, dataset_snapshot_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_method_sources_project_id
  ON method_sources (project_id, method_source_id);

ALTER TABLE task_specs
  ADD CONSTRAINT fk_task_specs_project_security
  FOREIGN KEY (project_id) REFERENCES projects(project_id) NOT VALID;
ALTER TABLE dataset_snapshots
  ADD CONSTRAINT fk_dataset_snapshots_project_spec_security
  FOREIGN KEY (project_id, task_spec_id)
  REFERENCES task_specs(project_id, task_spec_id) NOT VALID;
ALTER TABLE tasks
  ADD CONSTRAINT fk_tasks_project_spec_security
  FOREIGN KEY (project_id, task_spec_id)
  REFERENCES task_specs(project_id, task_spec_id) NOT VALID;
ALTER TABLE tasks
  ADD CONSTRAINT fk_tasks_project_dataset_security
  FOREIGN KEY (project_id, dataset_snapshot_id)
  REFERENCES dataset_snapshots(project_id, dataset_snapshot_id) NOT VALID;
ALTER TABLE project_members
  ADD CONSTRAINT fk_project_members_user_security
  FOREIGN KEY (user_id) REFERENCES users(user_id) NOT VALID;
ALTER TABLE project_resources
  ADD CONSTRAINT fk_project_resources_member_security
  FOREIGN KEY (project_id, owner_user_id)
  REFERENCES project_members(project_id, user_id) NOT VALID;
ALTER TABLE provider_profiles
  ADD CONSTRAINT fk_provider_profiles_member_security
  FOREIGN KEY (project_id, owner_user_id)
  REFERENCES project_members(project_id, user_id) NOT VALID;
ALTER TABLE provider_secrets
  ADD CONSTRAINT fk_provider_secrets_member_security
  FOREIGN KEY (project_id, owner_user_id)
  REFERENCES project_members(project_id, user_id) NOT VALID;

GRANT USAGE ON SCHEMA public, app TO infinity_api, infinity_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO infinity_api, infinity_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, auth_sessions, project_members, projects, task_specs, method_sources,
  dataset_snapshots, tasks, task_attempts, task_events, outbox_events,
  artifacts, idempotency_keys, project_resources, session_resource_links,
  provider_profiles, provider_secrets
TO infinity_api;

GRANT SELECT, INSERT, UPDATE ON tasks, task_attempts, task_events, artifacts TO infinity_worker;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO infinity_worker;
REVOKE ALL ON sessions, messages, paper_records, paper_records_global,
  authorized_paper_refs, session_paper_links, session_uploaded_papers,
  paper_cache, paper_cache_global, session_tool_calls,
  session_context_compression
FROM infinity_worker;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'project_members', 'task_specs', 'method_sources',
    'dataset_snapshots', 'tasks', 'task_attempts', 'task_events',
    'outbox_events', 'artifacts', 'idempotency_keys', 'project_resources',
    'session_resource_links', 'provider_profiles', 'provider_secrets'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;

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

DROP POLICY IF EXISTS method_project_member_policy ON method_sources;
CREATE POLICY method_project_member_policy ON method_sources
  FOR ALL TO infinity_api
  USING (app.project_access(project_id, app.current_user_id()))
  WITH CHECK (app.project_access(project_id, app.current_user_id()));

DROP POLICY IF EXISTS dataset_project_member_policy ON dataset_snapshots;
CREATE POLICY dataset_project_member_policy ON dataset_snapshots
  FOR ALL TO infinity_api
  USING (app.project_access(project_id, app.current_user_id()))
  WITH CHECK (app.project_access(project_id, app.current_user_id()));

DROP POLICY IF EXISTS task_project_member_policy ON tasks;
CREATE POLICY task_project_member_policy ON tasks
  FOR ALL TO infinity_api
  USING (app.project_access(project_id, app.current_user_id()))
  WITH CHECK (app.project_access(project_id, app.current_user_id()));

DROP POLICY IF EXISTS attempt_worker_policy ON task_attempts;
CREATE POLICY attempt_worker_policy ON task_attempts
  FOR ALL TO infinity_worker
  USING (worker_id = app.current_worker_id())
  WITH CHECK (worker_id = app.current_worker_id());

DROP POLICY IF EXISTS task_worker_policy ON tasks;
CREATE POLICY task_worker_policy ON tasks
  FOR ALL TO infinity_worker
  USING (status = 'queued' OR lease_owner = app.current_worker_id())
  WITH CHECK (lease_owner = app.current_worker_id() OR status = 'queued');

DROP POLICY IF EXISTS event_worker_policy ON task_events;
CREATE POLICY event_worker_policy ON task_events
  FOR ALL TO infinity_worker
  USING (EXISTS (SELECT 1 FROM task_attempts a
                 WHERE a.task_attempt_id = task_events.task_attempt_id
                   AND a.worker_id = app.current_worker_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM task_attempts a
                      WHERE a.task_attempt_id = task_events.task_attempt_id
                        AND a.worker_id = app.current_worker_id()));

DROP POLICY IF EXISTS artifact_worker_policy ON artifacts;
CREATE POLICY artifact_worker_policy ON artifacts
  FOR ALL TO infinity_worker
  USING (EXISTS (SELECT 1 FROM task_attempts a
                 WHERE a.task_attempt_id = artifacts.task_attempt_id
                   AND a.worker_id = app.current_worker_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM task_attempts a
                      WHERE a.task_attempt_id = artifacts.task_attempt_id
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
  USING (EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
                 ON pm.project_id = t.project_id
                WHERE t.task_id = artifacts.task_id
                  AND pm.user_id = app.current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM tasks t JOIN project_members pm
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
