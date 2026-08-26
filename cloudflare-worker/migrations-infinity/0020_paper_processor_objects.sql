-- Processor-owned per-page text and image metadata. The object bytes remain in
-- R2 and object names are reconstructed server-side from validated IDs.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper_processor_objects (
  resource_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text_pages', 'image')),
  object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 255),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 2147483648),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL CHECK (length(content_type) <= 128),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_id, kind, object_id),
  FOREIGN KEY (resource_id) REFERENCES paper_resources(resource_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES paper_processing_attempts(attempt_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_processor_objects_attempt
  ON paper_processor_objects(attempt_id, kind);
