import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEnvironment } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl.ts";
import { type RunOptions, type RunOutcome, runTask } from "../src/orchestrator.ts";
import type { LedgerEntry, RunEvent } from "../src/records.ts";
import { type RunLayout, runLayout } from "../src/run-layout.ts";
import { type CodeTask, defineTask } from "../src/task.ts";
import { createFakeEvaluator } from "./support/fake-evaluator.ts";
import { type ScriptedCodeModelOptions, createScriptedCodeModel, scriptedReview } from "./support/scripted-code-model.ts";

let root: string;
let truth: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-branch-"));
  truth = join(root, "truth.txt");
  writeFileSync(truth, "100");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const HINTS = ["h1", "h2", "h3"];
const value = (hint: string, cycle: number) => Number(hint.slice(1)) * 10 + cycle;
const EVERY = 0.004; // minutes: a review about every 240 ms per agent

const task = (overrides: Partial<CodeTask> = {}) =>
  defineTask({
    name: "branch",
    mode: "code",
    prompt: "Raise the number in pred.txt.",
    hidden: [truth],
    evaluate: createFakeEvaluator({ original: truth }).evaluate,
    metric: { name: "score", direction: "max" },
    review: false,
    agents: 2,
    model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
    stop: "until-stopped",
    branchReview: { everyMinutes: EVERY, maxTurns: 4, maxConcurrent: 2 },
    runsDir: root,
    ...overrides,
  });

/** Runs the task until `done` says so (checked every 25 ms against the events), then stops it like a user would. */
async function runUntil(
  definition: CodeTask,
  modelOptions: Partial<ScriptedCodeModelOptions>,
  done: (events: RunEvent[], layout: RunLayout, model: ReturnType<typeof createScriptedCodeModel>) => boolean,
  options: { runDir?: string; timeoutMs?: number; createEnvironment?: RunOptions["createEnvironment"] } = {},
) {
  const model = createScriptedCodeModel({ hints: HINTS, value, latencyMs: 15, ...modelOptions });
  const controller = new AbortController();
  const runDir = options.runDir ?? join(root, "run");
  const layout = runLayout(runDir);
  const timer = setInterval(() => {
    const events = existsSync(layout.events) ? new JsonlFile<RunEvent>(layout.events).readAll() : [];
    if (done(events, layout, model)) controller.abort();
  }, 25);
  const deadline = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  let outcome: RunOutcome;
  try {
    outcome = await runTask(definition, {
      createClient: () => model,
      runDir,
      signal: controller.signal,
      ...(options.createEnvironment ? { createEnvironment: options.createEnvironment } : {}),
    });
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
  }
  return { model, outcome, layout, events: new JsonlFile<RunEvent>(layout.events).readAll(), ledger: new JsonlFile<LedgerEntry>(layout.ledger).readAll() };
}

const reviews = (events: RunEvent[]) => events.filter((event) => event.type === "review");
const count = (events: RunEvent[], n: number) => reviews(events).length >= n;
const noForks = (layout: RunLayout) => (existsSync(layout.reviewDir) ? readdirSync(layout.reviewDir) : []);

describe("branch review with real agents and a scripted model", () => {
  it("the reviewer's request is the agent's request plus the review question: same system text, same tools, same earlier messages", async () => {
    const { model } = await runUntil(task(), {}, (events) => count(events, 2));
    expect(model.branchRequests.length).toBeGreaterThan(0);
    for (const review of model.branchRequests) {
      const question = review.messages.findIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("outside reviewer"));
      const before = review.messages.slice(0, question);
      // some request of a main agent is exactly the conversation before the question (same system, same tools)
      const match = [...model.agentRequests]
        .reverse()
        .find(
          (main) =>
            main.system === review.system &&
            JSON.stringify(main.tools) === JSON.stringify(review.tools) &&
            main.messages.length <= before.length &&
            main.messages.every((message, index) => JSON.stringify(message) === JSON.stringify(before[index])),
        );
      expect(match, "a main request that is a prefix of the review request").toBeDefined();
      // and nothing else was added to the conversation except what the fork file already held
      expect(before.length - (match?.messages.length ?? 0)).toBeLessThanOrEqual(2);
    }
  });

  it("records a snapshot with null steer without changing the main session", async () => {
    const { events, layout } = await runUntil(task(), {}, (events) => count(events, 2));
    expect(reviews(events).every((event) => event.outcome === "ok" && event.text === undefined)).toBe(true);
    expect(reviews(events).every((event) => event.snapshot?.steer === null && event.snapshot.sortValue === null)).toBe(true);
    for (const agent of [1, 2]) {
      const session = readFileSync(layout.sessionFile(agent), "utf8");
      expect(session).not.toContain("outside reviewer");
      expect(session).not.toContain("Outside review");
    }
    expect(noForks(layout)).toEqual([]);
  });

  it("routes worker commands and reviewer reads through separate deployment environments", async () => {
    const environments: Array<{ workDir: string; sharedDir: string; commands: string[]; reads: string[] }> = [];
    const command = "printf environment-wired";
    const { layout } = await runUntil(
      task({ agents: 1 }),
      {
        extraCalls: () => [{ name: "bash", args: { command } }],
        reviewer: (step) => (step === 1 ? { call: { name: "read", args: { path: "pred.txt" } } } : { text: scriptedReview() }),
      },
      (events) => count(events, 1) && environments[0]?.commands.includes(command) === true,
      {
        createEnvironment({ workDir, sharedDir }) {
          const observation = { workDir, sharedDir, commands: [] as string[], reads: [] as string[] };
          environments.push(observation);
          const env = createLocalEnvironment(workDir);
          return {
            ...env,
            spawn(value, options) {
              observation.commands.push(value);
              return env.spawn(value, options);
            },
            readFile(path) {
              observation.reads.push(path);
              return env.readFile(path);
            },
          };
        },
      },
    );
    expect(environments[0]).toMatchObject({ workDir: layout.workDir(1), sharedDir: layout.sharedDir, commands: expect.arrayContaining([command]) });
    expect(environments.slice(1).some(({ reads }) => reads.some((path) => path.endsWith("pred.txt")))).toBe(true);
  });

  it("advice is steered into the agent once, marked as not from the user and as old, before its next request; the reviewer never ran the goal check", async () => {
    const { events, layout, model } = await runUntil(
      task({ agents: 1 }),
      { reviewer: (step) => ({ text: scriptedReview(step === 1 ? "Try changing the number first." : null) }) },
      (events) => reviews(events).some((event) => event.outcome === "steer") && count(events, 3),
    );
    const steers = reviews(events).filter((event) => event.outcome === "steer");
    expect(steers.length).toBeGreaterThanOrEqual(1);
    const session = readFileSync(layout.sessionFile(1), "utf8");
    const delivered = session.split("\n").filter((line) => line.includes("[Outside review. This note is not from the user."));
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(delivered.length).toBeLessThanOrEqual(steers.length); // every steer at most once (the last may still be waiting at the stop)
    expect(delivered[0]).toMatch(/replies and about \d+ minutes ago/);
    expect(delivered[0]).toContain("Try changing the number first.");
    expect(model.goalChecks).toBe(0);
    // the next main request after the steer contains the advice
    const adviceAt = model.agentRequests.findIndex((request) => JSON.stringify(request.messages).includes("Outside review."));
    expect(adviceAt).toBeGreaterThan(0);
    expect(noForks(layout)).toEqual([]);
  });

  it("the reviewer may read inside the agent's directory; write, edit, bash, submit and reads elsewhere are denied and change nothing", async () => {
    const calls = [
      { name: "read", args: { path: "pred.txt" } },
      { name: "read", args: { path: "../../../ledger.jsonl" } },
      { name: "write", args: { path: "hacked.txt", content: "x" } },
      { name: "edit", args: { path: "pred.txt" } },
      { name: "bash", args: { command: "touch hacked2.txt" } },
      { name: "submit", args: { command: "echo hacked", files: ["pred.txt"] } },
    ];
    const { model, layout, ledger } = await runUntil(
      task({ agents: 1, branchReview: { everyMinutes: EVERY, maxTurns: 8, maxConcurrent: 1 } }),
      { reviewer: (step) => (step <= calls.length ? { call: calls[step - 1] as { name: string; args: unknown } } : { text: scriptedReview() }) },
      (events) => count(events, 2),
    );
    const results = model.branchToolResults;
    expect(results[0]).toMatch(/^\d+$/); // the file was read
    expect(results.slice(1, 6).every((text) => /only .*read|Only read|own directory/i.test(text))).toBe(true);
    expect(existsSync(join(layout.workDir(1), "hacked.txt"))).toBe(false);
    expect(existsSync(join(layout.workDir(1), "hacked2.txt"))).toBe(false);
    // no ledger line came from a reviewer: every result line is one of the main agent's own "echo N" commands
    expect(ledger.filter((entry) => entry.type === "result").every((entry) => /^echo \d+$/.test(entry.command))).toBe(true);
  });

  it("ends at maxTurns and rejects a review without a final snapshot", async () => {
    const { events, model } = await runUntil(
      task({ agents: 1, branchReview: { everyMinutes: EVERY, maxTurns: 3, maxConcurrent: 1 } }),
      { reviewer: () => ({ call: { name: "read", args: { path: "pred.txt" } } }) },
      (events) => count(events, 2),
    );
    expect(reviews(events).every((event) => event.outcome === "error" && !event.snapshot)).toBe(true);
    const replies = model.branchRequests.map((request) => {
      const question = request.messages.findIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("outside reviewer"));
      return request.messages.slice(question).filter((message) => message.role === "assistant").length;
    });
    expect(Math.max(...replies)).toBeLessThanOrEqual(3);
    expect(model.goalChecks).toBe(0);
  });

  it("an error in the reviewer is recorded and the main agent goes on; five in a row switch the feature off and say so", async () => {
    const { events, ledger, layout } = await runUntil(task({ agents: 1 }), { reviewer: () => ({ fail: "reviewer exploded" }) }, (events) =>
      events.some((event) => event.type === "review_off"),
    );
    // (the helper stops the run once the switch-off is recorded)
    expect(reviews(events).every((event) => event.outcome === "error")).toBe(true);
    expect(reviews(events).length).toBe(5);
    const off = events.find((event) => event.type === "review_off");
    expect(off).toMatchObject({ reason: expect.stringContaining("5 reviews failed in a row") });
    expect(ledger.filter((entry) => entry.type === "result").length).toBeGreaterThan(2); // the main agent kept working
    expect(noForks(layout)).toEqual([]);
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("Switched off");
  });

  it("counts review tokens on their own, and they are part of the total; the report lists the reviews and the steers", async () => {
    const { events, layout, outcome } = await runUntil(
      task({ agents: 1 }),
      { reviewer: (step) => ({ text: scriptedReview(step === 1 ? "Change approach." : null) }), tokens: { input: 100, output: 20 } },
      (events) => reviews(events).some((event) => event.outcome === "steer"),
    );
    const reviewTokens = reviews(events).reduce((sum, event) => sum + event.tokens, 0);
    expect(reviewTokens).toBeGreaterThan(0);
    expect(outcome.tokensUsed).toBeGreaterThan(reviewTokens);
    const html = readFileSync(layout.reportHtml, "utf8");
    expect(html).toContain("<h2>Reviews</h2>");
    expect(html).toContain("Change approach.");
  });

  it("a stop of the run during a review ends the review and leaves no fork file", async () => {
    // a review is in flight (its fork file exists) and hangs; the run is stopped; it must end by itself and clean up
    const { layout, events } = await runUntil(task({ agents: 1 }), { reviewer: () => ({ hang: true }) }, (_events, layout) => noForks(layout).length > 0);
    expect(events.at(-1)).toMatchObject({ type: "run_end", reason: "stopped" });
    expect(noForks(layout)).toEqual([]);
  }, 30_000);

  it("sweeps a fork file left by a killed run when the run starts again", async () => {
    const layout = runLayout(join(root, "run"));
    mkdirSync(layout.reviewDir, { recursive: true });
    writeFileSync(join(layout.reviewDir, "001-9.jsonl"), "{}\n");
    writeFileSync(join(layout.reviewDir, "001-9.jsonl.lock"), "");
    const { layout: after } = await runUntil(task({ agents: 1 }), {}, (events) => events.some((event) => event.type === "rung" || event.type === "run_start"));
    expect(readdirSync(after.reviewDir).includes("001-9.jsonl")).toBe(false);
  });

  it("with the branch review off nothing changes: no review events, no reviews directory, no Reviews section", async () => {
    const { branchReview: _on, ...withoutReview } = task({ agents: 1 });
    const off = withoutReview as CodeTask;
    const { events, layout, model } = await runUntil(
      off,
      {},
      (_events, layout) =>
        existsSync(layout.ledger) && new JsonlFile<LedgerEntry>(layout.ledger).readAll().filter((entry) => entry.type === "result").length >= 4,
    );
    expect(events.some((event) => event.type === "review" || event.type === "review_off" || event.type === "review_skips")).toBe(false);
    expect(existsSync(layout.reviewDir)).toBe(false);
    expect(readFileSync(layout.reportHtml, "utf8")).not.toContain("<h2>Reviews</h2>");
    expect(model.branchRequests).toEqual([]);
  }, 30_000);

  it("records structured snapshots for ten agents with a task-defined sort and no steer", async () => {
    const definition = task({
      agents: 10,
      branchReview: {
        everyMinutes: EVERY,
        maxConcurrent: 3,
        output: {
          criteria: "Watch for the first prediction.",
          fields: { stage: { type: "enum", values: ["started", "prediction_ready"], description: "Prediction progress" } },
          sort: { field: "stage", direction: "max" },
        },
      },
    });
    const { events, layout, model } = await runUntil(
      definition,
      { reviewer: () => ({ text: scriptedReview(null, { stage: "prediction_ready" }) }) },
      (events) =>
        new Set(
          reviews(events)
            .filter((event) => event.snapshot)
            .map((event) => event.agent),
        ).size >= 10,
      { timeoutMs: 60_000 },
    );
    const snapshots = reviews(events);
    expect(new Set(snapshots.map((event) => event.agent)).size).toBe(10);
    expect(snapshots.every((event) => event.outcome === "ok" && event.snapshot?.sortValue === 1 && event.snapshot.evidence.length === 1)).toBe(true);
    expect(model.branchRequests.some((request) => JSON.stringify(request.messages).includes("Watch for the first prediction."))).toBe(true);
    expect(model.agentRequests.some((request) => JSON.stringify(request.messages).includes("Outside review."))).toBe(false);
    expect(noForks(layout)).toEqual([]);
  }, 70_000);
});
