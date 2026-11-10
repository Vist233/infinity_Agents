import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVerifier, forbiddenConstruct, statementSource } from "../src/verifier.ts";
import { FakeLeanRunner, type FakeLeanHandler } from "./support/fake-lean-runner.ts";

const NONCE = "n0nce";
const PROOF = "import Statement\ntheorem main : Statement.Goal := by intro n; omega\n";

let leanDir: string;
beforeEach(() => {
  leanDir = mkdtempSync(join(tmpdir(), "infinity-verifier-"));
});
afterEach(() => rmSync(leanDir, { recursive: true, force: true }));

const make = (handler: FakeLeanHandler) => {
  const runner = new FakeLeanRunner(handler);
  return { runner, created: createVerifier({ runner, leanDir, statement: "True", newNonce: () => NONCE }) };
};

/** Answers the proof compile with success and the check with a given report line. */
const withReport =
  (report: string): FakeLeanHandler =>
  (request) =>
    request.args[0] === "Check.lean" ? { output: `${NONCE}|${report}` } : {};

describe("statementSource", () => {
  it("puts the proposition into Statement.Goal", () => {
    expect(statementSource("1 = 1")).toBe("namespace Statement\nabbrev Goal : Prop := 1 = 1\nend Statement\n");
  });
});

describe("forbiddenConstruct", () => {
  it.each([
    "#eval 1",
    "initialize foo : IO Unit",
    'macro "x" : tactic => `(tactic| rfl)',
    'elab "y" : tactic => pure ()',
    "@[implemented_by f] def g := 1",
    "run_cmd pure ()",
    "unsafe def z := 1",
    "#exit",
  ])("refuses %s", (source) => {
    expect(forbiddenConstruct(`import Statement\n${source}`)).toBeDefined();
  });
  it("refuses imports other than Statement", () => {
    expect(forbiddenConstruct("import Statement\nimport Lean\n")).toContain("import Lean");
  });
  it("accepts an ordinary proof, also one that mentions similar words inside names", () => {
    expect(forbiddenConstruct(`${PROOF}theorem my_macro_free : True := trivial\n`)).toBeUndefined();
  });
});

describe("createVerifier with a fake prover", () => {
  it("compiles the statement first and fails loudly when it does not compile", async () => {
    const { created } = make(() => ({ exitCode: 1, output: "unknown identifier" }));
    await expect(created).rejects.toThrow("The statement does not compile");
  });

  it("check returns the messages, or a clear note when there are none, or when Lean was stopped", async () => {
    let answer: Parameters<typeof make>[0] extends (...a: any) => infer R ? R : never = {};
    const { created } = make((_request, index) => (index === 0 ? {} : answer));
    const verifier = await created;
    expect(await verifier.check(PROOF)).toBe("No errors or warnings.");
    answer = { exitCode: 1, output: "Proof.lean:2:4: error: unsolved goals" };
    expect(await verifier.check(PROOF)).toContain("unsolved goals");
    answer = { timedOut: true, exitCode: null };
    expect(await verifier.check(PROOF)).toContain("stopped after");
  });

  it("runs the check in a scratch directory that is the only writable place, and removes it afterwards", async () => {
    const { runner, created } = make(withReport("ok|true|true|propext"));
    const verifier = await created;
    await verifier.verify(PROOF);
    const [compile, check] = runner.requests.slice(1);
    expect(compile?.writableDirs).toEqual([compile?.cwd]);
    expect(compile?.args).toEqual(["-o", "Proof.olean", "Proof.lean"]);
    expect(check?.args).toEqual(["Check.lean"]);
    expect(existsSync(compile?.cwd ?? "")).toBe(false);
    expect(readdirSync(leanDir)).toEqual(["Statement.lean"]);
  });

  it("writes the nonce into the verifier's own check file, not into the proof", async () => {
    const seen: string[] = [];
    const { created } = make((request) => {
      if (request.args[0] === "Check.lean") seen.push(readFileSync(join(request.cwd, "Check.lean"), "utf8"));
      return withReport("ok|true|true|")(request, 0) as object;
    });
    await (await created).verify(PROOF);
    expect(seen[0]).toContain(NONCE);
    expect(PROOF).not.toContain(NONCE);
  });

  it("accepts a theorem of exactly the right type with only the standard axioms", async () => {
    const { created } = make(withReport("ok|true|true|propext;Classical.choice;Quot.sound"));
    expect(await (await created).verify(PROOF)).toEqual({ proved: true, reason: "proved" });
  });

  it("accepts a proof that needs no axiom at all", async () => {
    const { created } = make(withReport("ok|true|true|"));
    expect((await (await created).verify(PROOF)).proved).toBe(true);
  });

  it.each([
    ["missing", "there is no theorem named 'main'"],
    ["ok|false|true|propext", "does not have exactly the type"],
    ["ok|true|false|propext", "must be a theorem"],
    ["ok|true|true|sorryAx", "sorryAx"],
    ["ok|true|true|propext;myAxiom", "myAxiom"],
    ["ok|true|true|Lean.ofReduceBool", "Lean.ofReduceBool"],
  ])("rejects the report %s", async (report, reason) => {
    const { created } = make(withReport(report));
    const verdict = await (await created).verify(PROOF);
    expect(verdict.proved).toBe(false);
    expect(verdict.reason).toContain(reason);
  });

  it("rejects a file that does not compile, with Lean's messages", async () => {
    const { created } = make((_request, index) => (index === 0 ? {} : { exitCode: 1, output: "Proof.lean:2:0: error: bad" }));
    const verdict = await (await created).verify(PROOF);
    expect(verdict).toMatchObject({ proved: false });
    expect(verdict.reason).toContain("does not compile");
    expect(verdict.reason).toContain("error: bad");
  });

  it("rejects when the report is missing or carries another nonce (a forged line)", async () => {
    const forged: FakeLeanHandler = (request) => (request.args[0] === "Check.lean" ? { output: "forged|ok|true|true|" } : {});
    const verdict = await (await make(forged).created).verify(PROOF);
    expect(verdict.proved).toBe(false);
    expect(verdict.reason).toContain("did not report");
  });

  it("rejects a forbidden construct without starting Lean", async () => {
    const { runner, created } = make(withReport("ok|true|true|"));
    const verifier = await created;
    const before = runner.requests.length;
    expect((await verifier.verify(`${PROOF}#eval 1\n`)).proved).toBe(false);
    expect(runner.requests.length).toBe(before);
  });

  it("rejects when the check run times out", async () => {
    const { created } = make((request) => (request.args[0] === "Check.lean" ? { timedOut: true, exitCode: null } : {}));
    expect((await (await created).verify(PROOF)).proved).toBe(false);
  });
});
