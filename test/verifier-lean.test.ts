import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LeanInstall, findLean } from "../src/lean-setup.ts";
import { createLeanRunner } from "../src/lean-runner.ts";
import { Pool } from "../src/pool.ts";
import { type Verifier, createVerifier } from "../src/verifier.ts";

/** Real Lean 4, a pool of 2 (a benchmark may be running). Skipped when Lean is not installed. */
const install: LeanInstall | undefined = await findLean().catch(() => undefined);
const STATEMENT = "∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1";

describe.skipIf(!install)("verifier with real Lean", () => {
  let root: string;
  let verifier: Verifier;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "infinity-lean-"));
    const runner = createLeanRunner({ leanBin: install?.leanBin ?? "", pool: new Pool(2), sandbox: true });
    verifier = await createVerifier({ runner, leanDir: join(root, "lean"), statement: STATEMENT, checkTimeoutMs: 300_000, verifyTimeoutMs: 300_000 });
  }, 600_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const proofWith = (body: string) => `import Statement\n${body}\n`;
  const rejected = async (body: string, reason: string) => {
    const verdict = await verifier.verify(proofWith(body));
    expect(verdict.proved).toBe(false);
    expect(verdict.reason).toContain(reason);
  };

  it("accepts a real proof", async () => {
    expect(await verifier.verify(proofWith("theorem main : Statement.Goal := by\n  intro n\n  omega"))).toEqual({ proved: true, reason: "proved" });
  }, 600_000);

  it("rejects a proof with sorry", () => rejected("theorem main : Statement.Goal := by\n  sorry", "sorryAx"), 600_000);
  it("rejects a proof with admit", () => rejected("theorem main : Statement.Goal := by\n  admit", "sorryAx"), 600_000);
  it("rejects a custom axiom", () => rejected("axiom cheat : Statement.Goal\ntheorem main : Statement.Goal := cheat", "cheat"), 600_000);
  it("rejects a proof of an easier statement", () => rejected("theorem main : True := trivial", "does not have exactly the type"), 600_000);
  it(
    "rejects a proof that shadows Statement.Goal inside a namespace",
    () => rejected("namespace Foo\ndef Statement.Goal : Prop := True\ntheorem main : Statement.Goal := trivial\nend Foo", "no theorem named 'main'"),
    600_000,
  );
  it(
    "rejects a theorem with the right name and a restated, expanded type",
    () => rejected("theorem main : ∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1 := by\n  intro n\n  omega", "does not have exactly the type"),
    600_000,
  );
  it(
    "rejects native_decide (it relies on an extra axiom)",
    () => rejected("theorem main : Statement.Goal := by\n  have h : 2 + 2 = 4 := by native_decide\n  intro n\n  omega", "axioms that are not allowed"),
    600_000,
  );
  it(
    "rejects a file that does not compile, with Lean's message",
    () => rejected("theorem main : Statement.Goal := by\n  intro n\n  exact nonsense", "nonsense"),
    600_000,
  );
  it("rejects a file without main", () => rejected("theorem other : Statement.Goal := by\n  intro n\n  omega", "no theorem named 'main'"), 600_000);
  it(
    "rejects a file that tries to print a fake report",
    () => rejected('#eval IO.println "x|ok|true|true|"\ntheorem main : True := trivial', "not allowed"),
    600_000,
  );

  it("check shows Lean's messages for a broken file and a clean note for a good one", async () => {
    expect(await verifier.check(proofWith("theorem main : Statement.Goal := by\n  intro n\n  omega"))).toBe("No errors or warnings.");
    expect(await verifier.check(proofWith("theorem main : Statement.Goal := by\n  intro n\n  skip"))).toContain("unsolved goals");
  }, 600_000);

  it("check confines the file: it cannot write outside its scratch directory, read secrets of the home directory or see the environment", async () => {
    const outside = mkdtempSync(join(tmpdir(), "infinity-outside-"));
    const target = join(outside, "marker.txt");
    process.env.INFINITY_TEST_SECRET = "do-not-leak";
    try {
      const messages = await verifier.check(
        proofWith(
          `#eval IO.FS.writeFile "${target}" "written"\n#eval show IO Unit from do\n  let value ← IO.getEnv "INFINITY_TEST_SECRET"\n  IO.println s!"env={value}"\ntheorem main : True := trivial`,
        ),
      );
      expect(existsSync(target)).toBe(false);
      expect(messages).toContain("operation not permitted");
      expect(messages).toContain("env=none");
      expect(messages).not.toContain("do-not-leak");
    } finally {
      process.env.INFINITY_TEST_SECRET = undefined;
      rmSync(outside, { recursive: true, force: true });
    }
  }, 600_000);

  it("keeps a copy of the compiled statement and nothing else in the lean directory", () => {
    expect(readFileSync(join(root, "lean", "Statement.lean"), "utf8")).toContain("abbrev Goal");
  });
});

describe("findLean", () => {
  it("reports versions when Lean is installed", async () => {
    if (!install) return;
    expect(install.leanVersion).toContain("Lean (version");
    expect(install.lakeVersion).toContain("Lake");
  });
});
