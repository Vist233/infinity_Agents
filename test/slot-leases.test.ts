// Slots are the machine's: a second live run takes only what the first leaves of the cores.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSlots } from "../src/slot-leases.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infinity-leases-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("claimSlots", () => {
  it("a run alone gets what it asks for", () => {
    const claim = claimSlots(12, "/runs/a", { dir, cores: 16 });
    expect(claim).toMatchObject({ slots: 12, note: undefined });
    claim.release();
  });
  it("a second run gets what the first leaves, and says why; after the first ends the full number is back", () => {
    const first = claimSlots(12, "/runs/a", { dir, cores: 16 });
    const second = claimSlots(12, "/runs/b", { dir, cores: 16 });
    expect(second.slots).toBe(4);
    expect(second.note).toContain("4 instead of 12");
    expect(second.note).toContain("/runs/a");
    second.release();
    first.release();
    expect(claimSlots(12, "/runs/c", { dir, cores: 16 }).slots).toBe(12);
  });
  it("ignores and removes the lease of a run whose process is gone, and always gives at least one slot", () => {
    writeFileSync(join(dir, "999999999-dead.json"), JSON.stringify({ pid: 999_999_999, runDir: "/runs/dead", slots: 16 }));
    expect(claimSlots(8, "/runs/a", { dir, cores: 16 }).slots).toBe(8);
    claimSlots(16, "/runs/big", { dir, cores: 16, pid: process.ppid });
    expect(claimSlots(8, "/runs/b", { dir, cores: 16 }).slots).toBe(1);
  });
});
