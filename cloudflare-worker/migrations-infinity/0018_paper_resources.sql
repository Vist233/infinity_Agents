-- Additive Paper Workspace resource metadata. D1 is the metadata authority;
-- bytes and manifests are stored in R2 through a later processor protocol.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper_resources (
  resource_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('arxiv', 'pubmed_pmc', 'user_upload', 'approved_url')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 512),
  canonical_ref TEXT CHECK (canonical_ref IS NULL OR length(canonical_ref) BETWEEN 1 AND 512),
  title TEXT CHECK (title IS NULL OR length(title) <= 255),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'downloading', 'extracting', 'uploading', 'ready', 'failed', 'deleted', 'cancelled')),
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR length(source_sha256) = 64),
  pdf_object_key TEXT CHECK (pdf_object_key IS NULL OR length(pdf_object_key) <= 512),
  pdf_size_bytes INTEGER CHECK (pdf_size_bytes IS NULL OR (pdf_size_bytes >= 0 AND pdf_size_bytes <= 2147483648)),
  pdf_sha256 TEXT CHECK (pdf_sha256 IS NULL OR length(pdf_sha256) = 64),
  text_manifest_key TEXT CHECK (text_manifest_key IS NULL OR length(text_manifest_key) <= 512),
  image_manifest_key TEXT CHECK (image_manifest_key IS NULL OR length(image_manifest_key) <= 512),
  page_count INTEGER CHECK (page_count IS NULL OR (page_count >= 0 AND page_count <= 10000)),
  image_count INTEGER CHECK (image_count IS NULL OR (image_count >= 0 AND image_count <= 100000)),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 128),
  error_message_safe TEXT CHECK (error_message_safe IS NULL OR length(error_message_safe) <= 1024),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ready_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_resources_user_status
  ON paper_resources(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_resources_session
  ON paper_resources(session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS paper_processing_attempts (
  attempt_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  processor_id TEXT NOT NULL CHECK (length(processor_id) BETWEEN 1 AND 255),
  lease_token_hash TEXT NOT NULL CHECK (length(lease_token_hash) = 64),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'downloading', 'extracting', 'uploading', 'succeeded', 'failed', 'expired', 'cancelled')),
  started_at INTEGER,
  lease_expires_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 128),
  error_message_safe TEXT CHECK (error_message_safe IS NULL OR length(error_message_safe) <= 1024),
  FOREIGN KEY (resource_id) REFERENCES paper_resources(resource_id) ON DELETE CASCADE,
  UNIQUE (resource_id, fencing_epoch)
);
CREATE INDEX IF NOT EXISTS idx_paper_attempts_resource_status
  ON paper_processing_attempts(resource_id, status, fencing_epoch DESC);

CREATE TABLE IF NOT EXISTS paper_resource_links (
  session_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('search_result', 'read', 'upload')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, resource_id, purpose),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES paper_resources(resource_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_resource_links_resource
  ON paper_resource_links(resource_id, session_id);
