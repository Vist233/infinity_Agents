// The production Worker intentionally does not depend on Node types. These
// imports are test-only and are suppressed instead of widening the runtime
// type package just to inspect a migration file.
// @ts-ignore test-only Node builtin
import { readFileSync } from "node:fs";
// @ts-ignore test-only Node builtin
import { join } from "node:path";
import { describe, expect, it } from "vitest";

declare const process: { cwd(): string };

const migration = readFileSync(
  join(process.cwd(), "migrations-infinity", "0014_d1_worker_runtime.sql"),
  "utf8",
);
const hardeningMigration = readFileSync(
  join(process.cwd(), "migrations-infinity", "0015_c7_runtime_hardening.sql"),
  "utf8",
);
const immutableSessionsMigration = readFileSync(
  join(process.cwd(), "migrations-infinity", "0016_immutable_worker_sessions.sql"),
  "utf8",
);
const chatEventsMigration = readFileSync(
  join(process.cwd(), "migrations-infinity", "0017_chat_events.sql"),
  "utf8",
);
const paperResourcesMigration = readFileSync(
  join(process.cwd(), "migrations-infinity", "0018_paper_resources.sql"),
  "utf8",
);
const paperProcessorObjectsMigration = readFileSync(
  join(process.cwd(), "migrations-infinity", "0020_paper_processor_objects.sql"),
  "utf8",
);
const paperPrivacyMigration = readFileSync(
  join(process.cwd(), "migrations-infinity", "0021_paper_privacy_cleanup.sql"),
  "utf8",
);

describe("canonical D1 Worker runtime schema", () => {
  it("uses the single public pool and D1-only data plane", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS worker_pool_policy");
    expect(migration).toContain("'public-default', 'infinity-public', 'public'");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS workers");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS worker_sessions_runtime");
  });

  it("contains fenced attempts, an outbox, and R2 multipart metadata", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS task_attempts");
    expect(migration).toContain("lease_token_hash TEXT NOT NULL");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS outbox_events");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS artifact_uploads");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS artifact_upload_parts");
    expect(migration).toContain("ALTER TABLE artifacts ADD COLUMN release_state");
  });

  it("normalizes compatibility task and Worker rows to the public pool", () => {
    expect(migration).toContain("UPDATE worker_registrations");
    expect(migration).toContain("worker_kind = 'public'");
    expect(migration).toContain("UPDATE tasks SET task_class = 'public'");
    expect(migration).toContain("execution_pool_id = 'public-default'");
  });

  it("records exclusive artifact finalization and recoverable outbox claims", () => {
    expect(hardeningMigration).toContain("finalize_owner");
    expect(hardeningMigration).toContain("finalize_started_at");
    expect(hardeningMigration).toContain("publishing_started_at");
    expect(hardeningMigration).toContain("publishing_owner");
    expect(hardeningMigration).toContain("refresh_owner");
    expect(hardeningMigration).toContain("token_version");
    expect(hardeningMigration).toContain("c7_artifact_upload_winners");
    expect(hardeningMigration).toContain("idx_artifacts_upload_unique");
  });

  it("keeps historical Worker sessions immutable with one active session", () => {
    expect(immutableSessionsMigration).toContain("UNIQUE(worker_id, session_epoch)");
    expect(immutableSessionsMigration).toContain("idx_worker_sessions_runtime_one_active");
    expect(immutableSessionsMigration).toContain("WHERE disconnected_at IS NULL");
    expect(immutableSessionsMigration).not.toContain("worker_id TEXT NOT NULL UNIQUE");
  });

  it("defines an additive, bounded, idempotent chat event ledger with legacy backfill", () => {
    expect(chatEventsMigration).toContain("CREATE TABLE IF NOT EXISTS chat_events");
    expect(chatEventsMigration).toContain("event_type IN (");
    expect(chatEventsMigration).toContain("role IN ('user', 'assistant', 'tool', 'system')");
    expect(chatEventsMigration).toContain("idx_chat_events_session_event");
    expect(chatEventsMigration).toContain("idx_chat_events_tool_call");
    expect(chatEventsMigration).toContain("WHERE event_type = 'tool_call'");
    expect(chatEventsMigration).toContain("'legacy:' || CAST(m.id AS TEXT)");
    expect(chatEventsMigration).toContain("'legacy'");
    expect(chatEventsMigration).toContain("NOT EXISTS");
    expect(chatEventsMigration).not.toContain("DROP TABLE");
  });

  it("defines authorized paper resources, fenced attempts, and session links additively", () => {
    expect(paperResourcesMigration).toContain("CREATE TABLE IF NOT EXISTS paper_resources");
    expect(paperResourcesMigration).toContain("CREATE TABLE IF NOT EXISTS paper_processing_attempts");
    expect(paperResourcesMigration).toContain("CREATE TABLE IF NOT EXISTS paper_resource_links");
    expect(paperResourcesMigration).toContain("requested");
    expect(paperResourcesMigration).toContain("downloading");
    expect(paperResourcesMigration).toContain("extracting");
    expect(paperResourcesMigration).toContain("uploading");
    expect(paperProcessorObjectsMigration).toContain("CREATE TABLE IF NOT EXISTS paper_processor_objects");
    expect(paperResourcesMigration).toContain("ready");
    expect(paperResourcesMigration).toContain("lease_token_hash TEXT NOT NULL");
    expect(paperResourcesMigration).toContain("fencing_epoch INTEGER NOT NULL");
    expect(paperResourcesMigration).toContain("FOREIGN KEY (session_id)");
    expect(paperResourcesMigration).not.toContain("DROP TABLE");
    expect(paperPrivacyMigration).toContain("CREATE TABLE IF NOT EXISTS paper_resource_audit_events");
    expect(paperPrivacyMigration).toContain("CREATE TABLE IF NOT EXISTS paper_cleanup_jobs");
    expect(paperPrivacyMigration).toContain("metadata_json");
    expect(paperPrivacyMigration).toContain("status IN ('pending', 'running', 'completed', 'failed')");
  });
});
