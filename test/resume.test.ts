import { mathModeWith } from "./support/math-mode-with.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl.ts";
import { runTask } from "../src/orchestrator.ts";
import type { LedgerEntry } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { loadState } from "../src/run-state.ts";
import { defineTask } from "../src/task.ts";
import { fakeVerifier } from "./support/fake-verifier.ts";
import { createScriptedModel } from "./support/scripted-model.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-resume-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("resume after a kill", () => {
  it("continues the same agents from their session files and proves", async () => {
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const child = spawn(process.execPath, [join(import.meta.dirname, "support", "child-run.ts"), runDir, root], { stdio: "ignore" });
    const submitsSoFar = () => new JsonlFile<LedgerEntry>(layout.ledger).readAll().filter((entry) => entry.type === "submit").length;
    await waitFor(() => submitsSoFar() >= 6, 30_000);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const killedState = loadState(layout.state);
    expect(killedState?.finished).toBeNull();
    const liveBefore = Object.keys(killedState?.ladder.live ?? {}).map(Number);
    expect(liveBefore.length).toBeGreaterThanOrEqual(2);
    const submitsBefore = submitsSoFar();

    const model = createScriptedModel({ hints: [], isGood: () => true });
    const task = defineTask({
      name: "kill test",
      mode: "math",
      statement: "True",
      agents: 4,
      model: { baseUrl: "x", apiKey: "x", model: "x", contextWindow: 1 },
      stop: "first-success",
      runsDir: root,
    });
    const outcome = await runTask(task, { createClient: () => model, mode: mathModeWith({ verifier: fakeVerifier }), runDir, resume: true });

    expect(outcome.reason).toBe("proved");
    const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
    expect(ledger.filter((entry) => entry.type === "submit").length).toBeGreaterThan(submitsBefore);
    const resumed = ledger.filter((entry) => entry.type === "lifecycle" && entry.detail === "resumed").map((entry) => entry.agent);
    expect(resumed.sort()).toEqual(liveBefore.sort());
    const winner = outcome.proved[0] ?? 0;
    expect(liveBefore).toContain(winner);
    expect(existsSync(layout.provedMarker(winner))).toBe(true);
    // the session of the winner holds both lives of the agent: the work before the kill and after it
    expect(readFileSync(layout.sessionFile(winner), "utf8")).toContain("BAD");
  }, 60_000);
});
