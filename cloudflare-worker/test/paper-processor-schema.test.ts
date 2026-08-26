// @ts-ignore test-only Node builtin
import { readFileSync } from "node:fs";
// @ts-ignore test-only Node builtin
import { join } from "node:path";
import { describe, expect, it } from "vitest";

declare const process: { cwd(): string };

const migration = readFileSync(join(process.cwd(), "migrations-infinity", "0019_paper_processor_sessions.sql"), "utf8");

describe("Paper Processor control schema", () => {
  it("keeps processor sessions distinct from public Worker sessions and stores only hashes", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS paper_processor_sessions");
    expect(migration).toContain("session_token_hash TEXT NOT NULL");
    expect(migration).toContain("processor_id TEXT NOT NULL");
    expect(migration).toContain("revoked_at INTEGER");
    expect(migration).not.toContain("access_token TEXT");
    expect(migration).not.toContain("credential TEXT");
  });
});
