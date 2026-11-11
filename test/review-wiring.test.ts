import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl.ts";
import { runTask } from "../src/orchestrator.ts";
import type { LedgerEntry, RunEvent } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { type CodeTask, defineTask } from "../src/task.ts";
import { createFakeEvaluator } from "./support/fake-evaluator.ts";
import { createScriptedCodeModel } from "./support/scripted-code-model.ts";

let root: string;
let truth: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-review-"));
  truth = join(root, "truth.txt");
  writeFileSync(truth, "100");
  mkdirSync(join(root, "public"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const value = (hint: string, cycle: number) => Number(hint.slice(1)) * 10 + 15 * cycle;
const task = (overrides: Partial<CodeTask> = {}) =>
  defineTask({
    name: "reviewed",
    mode: "code",
    prompt: "Raise the number in pred.txt.",
    hidden: [truth],
    evaluate: createFakeEvaluator({ original: truth }).evaluate,
    metric: { name: "score", direction: "max" },
    review: {},
    agents: 2,
    model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
    stop: { targetScore: 0.9 },
    runsDir: root,
    ...overrides,
  });
const HINTS = ["h1", "h2", "h3", "h4"];

describe("the safety review in code mode", () => {
  it("lets the reviewer model judge ordinary commands, refuses forbidden ones before any model is asked, and records every refusal", async () => {
    const runDir = join(root, "run");
    const keeperDir = runLayout(runDir).keeperDir;
    const model = createScriptedCodeModel({
      hints: HINTS,
      value,
      extraCalls: (cycle) =>
        cycle === 1
          ? [
              { name: "bash", args: { command: "touch trained.txt" } },
              { name: "bash", args: { command: "git push origin main" } },
              { name: "bash", args: { command: `cat ${keeperDir}/x` } },
            ]
          : [],
    });
    const outcome = await runTask(task(), { createClient: () => model, runDir });

    expect(outcome.reason).toBe("target");
    // only the one ordinary command reached the reviewer model (write and submit are allowed by the rules, the other two refused by them)
    expect(model.reviews.length).toBeGreaterThanOrEqual(1);
    expect(model.reviews.every((action) => action.includes("touch trained.txt"))).toBe(true);
    const layout = runLayout(outcome.runDir);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    const denied = events.filter((event) => event.type === "action_denied");
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied.every((event) => event.decidedBy === "infinity-rules" && event.tool === "bash")).toBe(true);
    expect(denied.map((event) => event.reason).join("\n")).toMatch(/pushing code.*hidden from the agents/s);
    expect(existsSync(join(layout.workDir(1), "trained.txt")) || existsSync(join(layout.workDir(2), "trained.txt"))).toBe(true);
    expect(events.some((event) => event.type === "warning" && event.message.includes("review is OFF"))).toBe(false);
    expect(readFileSync(layout.reportHtml, "utf8")).not.toContain("review is OFF");
  });

  it("a reviewer that denies stops the action; the denial is recorded with the reviewer as the decider", async () => {
    const model = createScriptedCodeModel({
      hints: HINTS,
      value,
      extraCalls: (cycle) => (cycle === 1 ? [{ name: "bash", args: { command: "touch evil.txt" } }] : []),
      reviewVerdict: (action) => (action.includes("evil") ? "deny" : "allow"),
    });
    const outcome = await runTask(task(), { createClient: () => model, runDir: join(root, "run") });
    const layout = runLayout(outcome.runDir);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.some((event) => event.type === "action_denied" && event.decidedBy === "reviewer")).toBe(true);
    expect(existsSync(join(layout.workDir(1), "evil.txt"))).toBe(false);
  });

  it("the circuit breaker ends an agent that keeps trying forbidden things; the ladder replaces it and the run goes on", async () => {
    const model = createScriptedCodeModel({
      hints: HINTS,
      value: () => 1,
      extraCalls: () => [1, 2, 3, 4].map(() => ({ name: "bash", args: { command: "git push origin main" } })),
    });
    const outcome = await runTask(task({ agents: 1, review: { breakerConsecutive: 3 }, stop: "until-stopped", tokens: 40_000 }), {
      createClient: () => model,
      runDir: join(root, "run"),
      replacementWaitMs: 20, // the wait before a replacement doubles with every failure; this test is about the breaker, not the wait
    });
    const layout = runLayout(outcome.runDir);
    const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
    const ended = ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "ended");
    expect(ended.some((entry) => entry.type === "lifecycle" && entry.detail.includes("circuit breaker"))).toBe(true);
    // a new agent took its place
    expect(new Set(ledger.map((entry) => entry.agent)).size).toBeGreaterThan(1);
  });

  it("with the review switched off the run says so loudly in the events and the report", async () => {
    const model = createScriptedCodeModel({ hints: HINTS, value });
    const outcome = await runTask(task({ review: false }), { createClient: () => model, runDir: join(root, "run") });
    const layout = runLayout(outcome.runDir);
    expect(model.reviews).toEqual([]);
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("The safety review is OFF");
  });

  it("restores the hidden data when the run is stopped by the user", async () => {
    const model = createScriptedCodeModel({ hints: HINTS, value: () => 1 });
    const controller = new AbortController();
    const listenersBefore = process.listenerCount("exit");
    setTimeout(() => {
      expect(process.listenerCount("exit")).toBe(listenersBefore + 1); // the keeper's exit guard is on while the data is hidden
      controller.abort();
    }, 400);
    const outcome = await runTask(task({ stop: "until-stopped" }), { createClient: () => model, runDir: join(root, "run"), signal: controller.signal });
    expect(outcome.reason).toBe("stopped");
    expect(readFileSync(truth, "utf8")).toBe("100");
    expect(process.listenerCount("exit")).toBe(listenersBefore); // and gone afterwards
  });
});
