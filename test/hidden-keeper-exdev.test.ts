import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A rename across file systems fails with EXDEV. The test makes the second path do that, since a second real file system is not at hand.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (from.includes("other-disk")) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      real.renameSync(from, to);
    },
  };
});

const { DifferentFilesystemError, HiddenKeeper } = await import("../src/hidden-keeper.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infinity-exdev-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("HiddenKeeper on a path that cannot be renamed into the keeper", () => {
  it("names the cause, puts back what it had moved before, and leaves the journal closed", () => {
    const first = join(dir, "first.csv");
    const second = join(dir, "other-disk.csv");
    writeFileSync(first, "1");
    writeFileSync(second, "2");
    const keeper = new HiddenKeeper({ dir: join(dir, "keeper") });
    expect(() => keeper.hide([first, second])).toThrow(DifferentFilesystemError);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(HiddenKeeper.recover(join(dir, "keeper"))).toEqual({ restored: [], conflicts: [], missing: [] });
  });

  it("passes on any other error from the rename unchanged, also after putting back", () => {
    const keeper = new HiddenKeeper({ dir: join(dir, "keeper") });
    const gone = join(dir, "x.csv");
    writeFileSync(gone, "x");
    // a directory cannot be renamed onto a path whose parent does not exist: simulate by removing the keeper directory
    rmSync(join(dir, "keeper"), { recursive: true });
    expect(() => keeper.hide([gone])).toThrow();
    expect(existsSync(gone)).toBe(true);
  });
});
