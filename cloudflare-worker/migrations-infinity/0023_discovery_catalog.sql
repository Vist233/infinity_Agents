-- Infinity Discovery catalog. This migration is additive: existing Chat,
-- Task, Worker v2, Paper Processor, Outbox, and Artifact tables are untouched.
-- D1 remains the only structured-state authority; R2 stores large objects.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper_catalog (
  paper_id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  source_resource_id TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
  authors_json TEXT NOT NULL DEFAULT '[]' CHECK (length(authors_json) <= 32768),
  year INTEGER CHECK (year IS NULL OR (year >= 1800 AND year <= 2200)),
  venue TEXT CHECK (venue IS NULL OR length(venue) <= 512),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'processing', 'profiled', 'failed', 'deleted')),
  spam_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (spam_status IN ('pending', 'scientific_paper', 'non_paper', 'spam', 'invalid', 'review')),
  profile_version TEXT CHECK (profile_version IS NULL OR length(profile_version) <= 64),
  profile_json TEXT CHECK (profile_json IS NULL OR length(profile_json) <= 1048576),
  profile_sha256 TEXT CHECK (profile_sha256 IS NULL OR length(profile_sha256) = 64),
  overview_object_key TEXT CHECK (overview_object_key IS NULL OR length(overview_object_key) <= 512),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_resource_id) REFERENCES paper_resources(resource_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_paper_catalog_owner_status
  ON paper_catalog(owner_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_catalog_public_status
  ON paper_catalog(visibility, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS paper_capabilities (
  paper_id TEXT NOT NULL,
  analysis_id TEXT NOT NULL CHECK (length(analysis_id) BETWEEN 1 AND 128),
  capability_key TEXT NOT NULL CHECK (capability_key GLOB '[a-z0-9]*' AND length(capability_key) BETWEEN 1 AND 128),
  requirement TEXT NOT NULL DEFAULT 'required'
    CHECK (requirement IN ('required', 'optional')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (paper_id, analysis_id, capability_key, requirement),
  FOREIGN KEY (paper_id) REFERENCES paper_catalog(paper_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_capabilities_key
  ON paper_capabilities(capability_key, requirement, paper_id);

CREATE TABLE IF NOT EXISTS data_collections (
  collection_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  source_object_key TEXT NOT NULL UNIQUE CHECK (length(source_object_key) <= 512),
  source_filename TEXT NOT NULL CHECK (length(source_filename) BETWEEN 1 AND 255),
  source_content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_size_bytes INTEGER NOT NULL CHECK (source_size_bytes > 0 AND source_size_bytes <= 26214400),
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'inspecting', 'ready', 'failed', 'deleted')),
  profile_version TEXT CHECK (profile_version IS NULL OR length(profile_version) <= 64),
  profile_json TEXT CHECK (profile_json IS NULL OR length(profile_json) <= 1048576),
  profile_sha256 TEXT CHECK (profile_sha256 IS NULL OR length(profile_sha256) = 64),
  error_code TEXT CHECK (error_code IS NULL OR error_code GLOB '[A-Z0-9_]*'),
  error_message_safe TEXT CHECK (error_message_safe IS NULL OR length(error_message_safe) <= 1024),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, source_sha256)
);
CREATE INDEX IF NOT EXISTS idx_data_collections_owner_status
  ON data_collections(owner_user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dataset_capabilities (
  collection_id TEXT NOT NULL,
  capability_key TEXT NOT NULL CHECK (capability_key GLOB '[a-z0-9]*' AND length(capability_key) BETWEEN 1 AND 128),
  capability_value TEXT NOT NULL DEFAULT 'true' CHECK (length(capability_value) <= 4096),
  confidence INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, capability_key),
  FOREIGN KEY (collection_id) REFERENCES data_collections(collection_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dataset_capabilities_key
  ON dataset_capabilities(capability_key, collection_id);

CREATE TABLE IF NOT EXISTS research_matches (
  match_id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  paper_profile_version TEXT NOT NULL CHECK (length(paper_profile_version) <= 64),
  dataset_profile_version TEXT NOT NULL CHECK (length(dataset_profile_version) <= 64),
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'evaluating', 'evaluated', 'review', 'rejected', 'task_created', 'failed')),
  hard_gate TEXT NOT NULL DEFAULT 'pending'
    CHECK (hard_gate IN ('pending', 'pass', 'fail', 'review')),
  coverage_ratio REAL NOT NULL DEFAULT 0 CHECK (coverage_ratio >= 0 AND coverage_ratio <= 1),
  execution_confidence INTEGER CHECK (execution_confidence IS NULL OR execution_confidence BETWEEN 0 AND 100),
  scientific_fit INTEGER CHECK (scientific_fit IS NULL OR scientific_fit BETWEEN 0 AND 100),
  evaluator_version TEXT CHECK (evaluator_version IS NULL OR length(evaluator_version) <= 64),
  evaluation_json TEXT CHECK (evaluation_json IS NULL OR length(evaluation_json) <= 524288),
  created_task_id TEXT,
  candidate_reason TEXT CHECK (candidate_reason IS NULL OR length(candidate_reason) <= 4096),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (paper_id, collection_id, paper_profile_version, dataset_profile_version),
  FOREIGN KEY (paper_id) REFERENCES paper_catalog(paper_id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES data_collections(collection_id) ON DELETE CASCADE,
  FOREIGN KEY (created_task_id) REFERENCES tasks(task_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_research_matches_paper
  ON research_matches(paper_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_matches_collection
  ON research_matches(collection_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_matches_candidates
  ON research_matches(status, hard_gate, updated_at ASC);

-- Dedicated short-lived control sessions for the Windows Discovery service.
-- Only the hash of the session capability is persisted.
CREATE TABLE IF NOT EXISTS discovery_processor_sessions (
  processor_session_id TEXT PRIMARY KEY,
  processor_id TEXT NOT NULL CHECK (length(processor_id) BETWEEN 1 AND 255),
  instance_id TEXT NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 255),
  session_token_hash TEXT NOT NULL UNIQUE CHECK (length(session_token_hash) = 64),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_discovery_processor_sessions_active
  ON discovery_processor_sessions(processor_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS literature_watch_state (
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  last_cursor TEXT,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, query)
);
