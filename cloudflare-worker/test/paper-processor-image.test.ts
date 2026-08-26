// @ts-ignore test-only Node builtin
import { readFileSync } from "node:fs";
// @ts-ignore test-only Node builtin
import { join } from "node:path";
import { describe, expect, it } from "vitest";

declare const process: { cwd(): string };

describe("dedicated Paper Processor image boundary", () => {
  it("does not extend the public Claude Worker or embed parent service access", () => {
    const dockerfile = readFileSync(join(process.cwd(), "..", "backend", "Dockerfile.paper-processor"), "utf8").toLowerCase();
    const client = readFileSync(join(process.cwd(), "..", "backend", "paper_processor", "client.py"), "utf8").toLowerCase();
    const requirements = readFileSync(join(process.cwd(), "..", "backend", "requirements.paper-processor.txt"), "utf8").toLowerCase();
    expect(dockerfile).not.toMatch(/claude|redis|postgres|hyperdrive|d1|r2/);
    expect(client).not.toMatch(/redis|postgres|hyperdrive|d1|r2|access_token|database_url|credential_ciphertext/);
    expect(requirements).toMatch(/^pypdf>=/m);
    expect(requirements).toMatch(/^pymupdf>=/m);
    expect(requirements).not.toMatch(/redis|postgres|claude|asyncpg/);
    expect(dockerfile).toContain("backend/paper_processor");
    expect(client).toContain("x-paper-processor-session");
  });
});
