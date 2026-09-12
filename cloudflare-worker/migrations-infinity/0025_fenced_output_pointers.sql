-- Keep Processor output immutable per attempt. D1 publishes the one object
-- pointer that belongs to the fenced attempt; readers never reconstruct a
-- mutable canonical key for Processor output.
PRAGMA foreign_keys = ON;

ALTER TABLE paper_processor_objects ADD COLUMN object_key TEXT;
CREATE INDEX IF NOT EXISTS idx_paper_processor_objects_current
  ON paper_processor_objects(resource_id, kind, object_id, object_key);

ALTER TABLE paper_catalog ADD COLUMN profile_object_key TEXT;
ALTER TABLE data_collections ADD COLUMN profile_object_key TEXT;
ALTER TABLE research_matches ADD COLUMN evaluation_object_key TEXT;
