-- Cloudflare-native task control plane for the Analysis -> Coding flow.
-- Large inputs and artifacts stay in the dedicated private R2 bucket.

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_specs (
  task_spec_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  analysis_type TEXT NOT NULL DEFAULT 'generic',
  research_question TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  frozen_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_task_specs_user ON task_specs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_resources (
  resource_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('method', 'dataset')),
  logical_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  file_hash_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_task_resources_owner ON task_resources(user_id, project_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS method_sources (
  method_source_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (resource_id) REFERENCES task_resources(resource_id)
);

CREATE TABLE IF NOT EXISTS dataset_snapshots (
  dataset_snapshot_id TEXT PRIMARY KEY,
  task_spec_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  file_hash_sha256 TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  validation_passed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_spec_id) REFERENCES task_specs(task_spec_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (resource_id) REFERENCES task_resources(resource_id)
);
CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_owner ON dataset_snapshots(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  task_spec_id TEXT NOT NULL,
  dataset_snapshot_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  method_source_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('draft', 'queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'timeout')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  result_artifact_id TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (task_spec_id) REFERENCES task_specs(task_spec_id),
  FOREIGN KEY (dataset_snapshot_id) REFERENCES dataset_snapshots(dataset_snapshot_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS task_idempotency (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, idempotency_key),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE TABLE IF NOT EXISTS task_events (
  task_event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at ASC);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_size_bytes INTEGER,
  checksum_sha256 TEXT,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE TABLE IF NOT EXISTS worker_enrollments (
  worker_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (worker_id, namespace)
);
