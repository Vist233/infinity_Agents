import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
let data: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-code-"));
  truth = join(root, "truth.txt");
  writeFileSync(truth, "100");
  data = join(root, "public");
  mkdirSync(data);
  writeFileSync(join(data, "train.txt"), "public data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const HINTS = ["h1", "h2", "h3", "h4"];
// agent with hint hN starts at 10 N and gains 15 per cycle: h4 reaches 100 at cycle 4
const value = (hint: string, cycle: number) => Number(hint.slice(1)) * 10 + 15 * cycle;

const codeTask = (overrides: Partial<CodeTask> = {}, evaluate = createFakeEvaluator({ original: truth })) =>
  defineTask({
    name: "raise",
    mode: "code",
    prompt: "Raise the number in pred.txt.",
    files: { data },
    hidden: [truth],
    evaluate: evaluate.evaluate,
    metric: { name: "score", direction: "max" },
    review: false,
    agents: 4,
    model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
    stop: { targetScore: 0.9 },
    runsDir: root,
    ...overrides,
  });

describe("runTask in code mode with scripted agents", () => {
  it("scores every submit with the evaluator, hides the data meanwhile, and ends at the target score", async () => {
    const evaluator = createFakeEvaluator({ original: truth });
    const model = createScriptedCodeModel({ hints: HINTS, value });
    const outcome = await runTask(codeTask({}, evaluator), { createClient: () => model, runDir: join(root, "run") });

    expect(outcome.reason).toBe("target");
    expect(outcome.bestScore).toBeGreaterThanOrEqual(0.9);
    const layout = runLayout(outcome.runDir);
    const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
    const results = ledger.filter((entry) => entry.type === "result");
    expect(results.length).toBeGreaterThan(3);
    for (const entry of results) {
      expect(entry.command).toMatch(/^echo \d+$/);
      expect(entry.entry).toContain("=== pred.txt ===");
      expect(entry.selfReported).toBe(false);
      expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.workDir).toContain("agents/");
    }
    // the evaluator saw the committed state: the commit of a ledger line holds exactly the file the evaluator scored
    expect(evaluator.calls.every((call) => call.commit !== null && call.hidden[0] !== truth)).toBe(true);
    // the hidden file was away from its place during every evaluation, and is back now
    expect(evaluator.originalVisible.every((visible) => !visible)).toBe(true);
    expect(readFileSync(truth, "utf8")).toBe("100");
    expect(existsSync(layout.keeperDir)).toBe(true);
    // agents got shared data by a link, not by a copy in Git
    const agentOne = layout.workDir(1);
    expect(readFileSync(join(agentOne, "data", "train.txt"), "utf8")).toBe("public data");
    expect(readFileSync(join(agentOne, ".gitignore"), "utf8")).toContain("data");
    // markers, events, report
    expect(existsSync(layout.finishedMarker(1))).toBe(true);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.some((event) => event.type === "target")).toBe(true);
    expect(events.find((event) => event.type === "warning")).toMatchObject({ message: expect.stringContaining("review is OFF") });
    expect(events.at(-1)).toMatchObject({ type: "run_end", reason: "target" });
    const csv = readFileSync(layout.leaderboardCsv, "utf8").split("\n");
    expect(csv[0]).toBe("rank,agent,score,self_reported,submits,errors,commit,work_dir");
    expect(csv[1]).toMatch(/^1,\d+,[01]\.?\d*,false,/);
    const html = readFileSync(layout.reportHtml, "utf8");
    expect(html).toContain("Warnings");
    expect(html).toContain("<svg");
    expect(html).toContain("Latest submits");
    expect(JSON.parse(readFileSync(layout.state, "utf8"))).toMatchObject({ finished: "target" });
  });

  it("puts the hidden data back also when the budget ends the run", async () => {
    const model = createScriptedCodeModel({ hints: HINTS, value: () => 1, tokens: { input: 500, output: 100 } });
    const outcome = await runTask(codeTask({ tokens: 20_000, stop: "until-stopped" }), { createClient: () => model, runDir: join(root, "run") });
    expect(outcome.reason).toBe("budget");
    expect(readFileSync(truth, "utf8")).toBe("100");
  });

  it("serialises evaluations with evalSlots and tells the agent when the evaluator crashes", async () => {
    const evaluator = createFakeEvaluator({ original: truth, delayMs: 15, failOnCall: 2 });
    const model = createScriptedCodeModel({ hints: HINTS, value });
    const outcome = await runTask(codeTask({ evalSlots: 1 }, evaluator), { createClient: () => model, runDir: join(root, "run") });
    expect(evaluator.peak()).toBe(1);
    const results = new JsonlFile<LedgerEntry>(runLayout(outcome.runDir).ledger).readAll().filter((entry) => entry.type === "result");
    const errors = results.filter((entry) => entry.status === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.details).toContain("evaluator crashed");
    expect(errors[0]?.score).toBeNull();
  });

  it("without an evaluator ranks the agents' own claims and marks them self-reported", async () => {
    const model = createScriptedCodeModel({ hints: HINTS, value, claim: (cycle) => ({ accuracy: cycle / 100 }) });
    const task = defineTask({
      name: "claims",
      mode: "code",
      prompt: "Do something.",
      review: false,
      agents: 2,
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: "until-stopped",
      tokens: 8000,
      runsDir: root,
    });
    const outcome = await runTask(task, { createClient: () => model, runDir: join(root, "run") });
    const layout = runLayout(outcome.runDir);
    const results = new JsonlFile<LedgerEntry>(layout.ledger).readAll().filter((entry) => entry.type === "result");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry) => entry.selfReported)).toBe(true);
    expect(readFileSync(layout.leaderboardCsv, "utf8").split("\n")[1]).toContain("true");
    expect(outcome.bestScore).toBeNull(); // nothing was verified
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("self-reported");
  });

  it("fails before any agent starts when a shared file is missing, and leaves the hidden data alone", async () => {
    const model = createScriptedCodeModel({ hints: HINTS, value });
    await expect(runTask(codeTask({ files: { data: join(root, "nope") } }), { createClient: () => model, runDir: join(root, "run") })).rejects.toThrow(
      /does not exist/,
    );
    expect(readdirSync(root)).toContain("truth.txt");
    expect(readFileSync(truth, "utf8")).toBe("100");
  });
});
