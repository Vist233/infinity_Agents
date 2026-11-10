import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl.ts";
import { findLean } from "../src/lean-setup.ts";
import { runTask } from "../src/orchestrator.ts";
import type { LedgerEntry } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { defineTask } from "../src/task.ts";
import { createScriptedModel } from "./support/scripted-model.ts";

const install = await findLean().catch(() => undefined);

/** The whole run with real Lean (a pool of 2) and a scripted model: one agent writes a wrong proof, the other a right one. */
describe.skipIf(!install)("runTask with real Lean and scripted agents", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "infinity-real-lean-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("rejects the wrong file, accepts the real one, and the ledger and the markers show it", async () => {
    const model = createScriptedModel({
      hints: ["wrong", "right"],
      isGood: (hint) => hint === "right",
      goodProof: "import Statement\ntheorem main : Statement.Goal := by\n  intro n\n  omega\n",
    });
    const task = defineTask({
      name: "parity real lean",
      mode: "math",
      statement: "∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1",
      agents: 2,
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: "first-success",
      leanPool: 2,
      runsDir: root,
    });
    const outcome = await runTask(task, { createClient: () => model, runDir: join(root, "run") });
    expect(outcome.reason).toBe("proved");
    const layout = runLayout(outcome.runDir);
    expect(existsSync(layout.provedMarker(2))).toBe(true);
    const submits = new JsonlFile<LedgerEntry>(layout.ledger).readAll().filter((entry) => entry.type === "submit");
    expect(submits.find((entry) => entry.proved)?.agent).toBe(2);
    const rejected = submits.find((entry) => !entry.proved);
    expect(rejected?.reason).toContain("no theorem named 'main'"); // the wrong agent's file compiles but has no theorem main
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("theorem main : Statement.Goal");
  }, 600_000);
});
