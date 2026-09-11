-- Discovery work leases are separate from Paper Processor and Worker v2
-- attempts. They let a short-lived Discovery Processor restart without
-- leaving paper, dataset, or evaluation work permanently stuck.
ALTER TABLE paper_catalog ADD COLUMN discovery_lease_owner TEXT;
ALTER TABLE paper_catalog ADD COLUMN discovery_lease_expires_at INTEGER;
ALTER TABLE paper_catalog ADD COLUMN discovery_lease_token_hash TEXT;
ALTER TABLE paper_catalog ADD COLUMN discovery_fencing_epoch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE data_collections ADD COLUMN discovery_lease_owner TEXT;
ALTER TABLE data_collections ADD COLUMN discovery_lease_expires_at INTEGER;
ALTER TABLE data_collections ADD COLUMN discovery_lease_token_hash TEXT;
ALTER TABLE data_collections ADD COLUMN discovery_fencing_epoch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE research_matches ADD COLUMN discovery_lease_owner TEXT;
ALTER TABLE research_matches ADD COLUMN discovery_lease_expires_at INTEGER;
ALTER TABLE research_matches ADD COLUMN discovery_lease_token_hash TEXT;
ALTER TABLE research_matches ADD COLUMN discovery_fencing_epoch INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_discovery_paper_leases
  ON paper_catalog(status, discovery_lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_discovery_collection_leases
  ON data_collections(status, discovery_lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_discovery_match_leases
  ON research_matches(status, discovery_lease_expires_at);
