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
});
