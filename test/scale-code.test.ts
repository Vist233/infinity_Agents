import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl.ts";
import { runTask } from "../src/orchestrator.ts";
import type { LedgerEntry, RunEvent } from "../src/records.ts";
import { type RunLayout, runLayout } from "../src/run-layout.ts";
import { loadState } from "../src/run-state.ts";
import { type CodeTask, defineTask } from "../src/task.ts";
import { createFakeEvaluator } from "./support/fake-evaluator.ts";
import { createScriptedCodeModel } from "./support/scripted-code-model.ts";

let root: string;
let truth: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-scale-code-"));
  truth = join(root, "truth.txt");
  writeFileSync(truth, "1000000");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const HINTS = ["h1", "h2", "h3", "h4"];
const task = (overrides: Partial<CodeTask> = {}) =>
  defineTask({
    name: "scale code",
    mode: "code",
    prompt: "Raise the number in pred.txt.",
    hidden: [truth],
    evaluate: createFakeEvaluator({ original: truth }).evaluate,
    metric: { name: "score", direction: "max" },
    review: false,
    branchReview: { everyMinutes: 0.01, maxTurns: 3, maxConcurrent: 3 },
    agents: 30,
    model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
    stop: "until-stopped",
    runsDir: root,
    ...overrides,
  });

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const eventsOf = (layout: RunLayout) => (existsSync(layout.events) ? new JsonlFile<RunEvent>(layout.events).readAll() : []);
const ledgerOf = (layout: RunLayout) => (existsSync(layout.ledger) ? new JsonlFile<LedgerEntry>(layout.ledger).readAll() : []);
const forks = (layout: RunLayout) => (existsSync(layout.reviewDir) ? readdirSync(layout.reviewDir) : []);

/** Answered submits in an agent's session (a call cut off by a stop is 'interrupted' and has no ledger line). */
function submitsInSession(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes('"toolName":"submit"') && line.includes("Scored:")).length;
}

describe("30 scripted code agents with the branch review on", () => {
  it("climbs 1, 2, 4, 8, 16, 30, reviews run on the way and never pile up, and the ledger matches the sessions", async () => {
    const model = createScriptedCodeModel({ hints: HINTS, value: (_h, cycle) => cycle, latencyMs: 250 });
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const controller = new AbortController();
    const running = runTask(task(), { createClient: () => model, runDir, signal: controller.signal, checkEveryMs: 1000 });
    await waitFor(
      () => Object.keys(loadState(layout.state)?.ladder.live ?? {}).length === 30 && eventsOf(layout).filter((event) => event.type === "review").length >= 12,
      150_000,
    );
    controller.abort();
    const outcome = await running;

    expect(outcome.reason).toBe("stopped");
    const events = eventsOf(layout);
    const rungs = events.filter((event) => event.type === "rung").map((event) => (event.type === "rung" ? `${event.from}->${event.to}` : ""));
    expect(rungs).toEqual(["1->2", "2->4", "4->8", "8->16", "16->30"]);
    const reviews = events.filter((event) => event.type === "review");
    expect(reviews.length).toBeGreaterThanOrEqual(12);
    expect(new Set(reviews.map((event) => event.agent)).size).toBeGreaterThanOrEqual(6); // spread over agents, not one agent again and again
    expect(reviews.every((event) => event.outcome === "ok")).toBe(true);
    expect(forks(layout)).toEqual([]);
    // reviews of one agent are about one interval apart (0.01 minutes = 600 ms; the events are written at the end of a review, so allow for its length)
    for (const agent of new Set(reviews.map((event) => event.agent))) {
      const times = reviews.filter((event) => event.agent === agent).map((event) => event.ts);
      for (let i = 1; i < times.length; i += 1) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(300);
    }
    const ledger = ledgerOf(layout);
    const started = new Set(ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "started").map((entry) => entry.agent));
    expect(started.size).toBe(30);
    for (const agent of started) {
      const inLedger = ledger.filter((entry) => entry.type === "result" && entry.agent === agent).length;
      const inSession = submitsInSession(layout.sessionFile(agent));
      expect([inSession, inSession + 1]).toContain(inLedger);
    }
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("<h2>Reviews</h2>");
    expect(readFileSync(truth, "utf8")).toBe("1000000"); // the hidden file is back
  }, 200_000);

  it("finds the provider's limit with reviews running, never exceeds it (reviews included), and holds the reviews while the Gate is paused", async () => {
    const limit = 10;
    const model = createScriptedCodeModel({ hints: HINTS, value: (_h, cycle) => cycle, latencyMs: 40, maxConcurrent: limit, retryAfterMs: 60 });
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const controller = new AbortController();
    const running = runTask(task({ branchReview: { everyMinutes: 0.005, maxTurns: 3, maxConcurrent: 3 } }), {
      createClient: () => model,
      runDir,
      signal: controller.signal,
      checkEveryMs: 500,
      pauseRetryMs: 20,
    });
    const summary = () => {
      const events = eventsOf(layout);
      const count = (type: string) => events.filter((event) => event.type === type).length;
      return `held=${loadState(layout.state)?.ladder.held} reviews=${count("review")} throttles=${count("throttle")} rungs=${count("rung")} requests=${model.requestCount}`;
    };
    try {
      await waitFor(
        () =>
          (loadState(layout.state)?.ladder.held ?? false) &&
          eventsOf(layout).filter((event) => event.type === "review").length >= 5 &&
          eventsOf(layout).filter((event) => event.type === "throttle").length >= 1,
        60_000,
      );
    } catch (error) {
      controller.abort();
      await running;
      throw new Error(`${String(error)}: ${summary()}`);
    }
    controller.abort();
    await running;

    expect(model.peakConcurrent).toBeLessThanOrEqual(limit);
    expect(model.throttled).toBeGreaterThan(0);
    const state = loadState(layout.state);
    expect(state?.ladder.limitRung).toBeGreaterThan(limit);
    const events = eventsOf(layout);
    expect(events.some((event) => event.type === "rung" && event.reason === "throttle")).toBe(true);
    const skips = events.findLast((event) => event.type === "review_skips");
    expect(skips).toBeDefined();
    expect(forks(layout)).toEqual([]);
  }, 150_000);

  it("stops everything at a quota end: reviews stop too, one quota event, no fork files, sessions kept", async () => {
    const model = createScriptedCodeModel({ hints: HINTS, value: (_h, cycle) => cycle, latencyMs: 30, quotaAfter: 250 });
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const outcome = await runTask(task({ branchReview: { everyMinutes: 0.005, maxTurns: 3, maxConcurrent: 3 } }), {
      createClient: () => model,
      runDir,
      checkEveryMs: 500,
      pauseRetryMs: 20,
    });
    expect(outcome.reason).toBe("quota");
    const after = model.requestCount;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(model.requestCount).toBe(after);
    const events = eventsOf(layout);
    expect(events.filter((event) => event.type === "quota")).toHaveLength(1);
    expect(forks(layout)).toEqual([]);
    expect(loadState(layout.state)?.finished).toBe("quota");
    expect(readFileSync(truth, "utf8")).toBe("1000000");
  }, 100_000);
});

describe("slow agents on the ladder", () => {
  /** Runs 8 scripted agents until the ladder reaches 8 and returns the milliseconds between the start and each rung, and the most agents alive at any time. */
  async function climb(latencyMs: number) {
    const model = createScriptedCodeModel({ hints: HINTS, value: (_h, cycle) => cycle, latencyMs });
    const runDir = join(root, `run-${latencyMs}`);
    const layout = runLayout(runDir);
    const controller = new AbortController();
    const running = runTask(task({ agents: 8, branchReview: undefined as never }), {
      createClient: () => model,
      runDir,
      signal: controller.signal,
      checkEveryMs: 1000,
    });
    await waitFor(() => Object.keys(loadState(layout.state)?.ladder.live ?? {}).length === 8, 120_000);
    controller.abort();
    await running;
    const events = eventsOf(layout);
    const start = events[0]?.ts ?? 0;
    const rungs = events.filter((event) => event.type === "rung");
    const live = Math.max(
      ...ledgerOf(layout)
        .filter((entry) => entry.type === "lifecycle" && entry.event === "started")
        .map((_entry, index) => index + 1),
    );
    return { times: rungs.map((rung) => rung.ts - start), replies: rungs.map((rung) => (rung.type === "rung" ? rung.replies : 0)), started: live };
  }

  it("a slow model slows the climb in proportion and never makes it skip a rung", async () => {
    const fast = await climb(30);
    const slow = await climb(400);
    expect(fast.times).toHaveLength(3); // 1->2, 2->4, 4->8
    expect(slow.times).toHaveLength(3);
    // each rung waits for three replies of every live agent: with 13 times the latency the whole climb takes several times longer
    expect(slow.times.at(-1) ?? 0).toBeGreaterThan(3 * (fast.times.at(-1) ?? 1));
    // every rung is closed by at least three replies from each agent that was alive (2, 4 and 8 agents: 6, 12 and 24 replies at least)
    expect(slow.replies.map((replies, index) => replies >= 3 * 2 ** index)).toEqual([true, true, true]);
    expect(fast.started).toBe(8);
    expect(slow.started).toBe(8);
    console.log(
      `ladder climb to 8 agents: model latency 30 ms -> ${fast.times.map((time) => `${time} ms`).join(", ")}; latency 400 ms -> ${slow.times.map((time) => `${time} ms`).join(", ")}`,
    );
  }, 200_000);
});

describe("kill and resume of a code run with the branch review on", () => {
  it("a SIGKILL leaves the sessions intact; the resumed run sweeps stray forks, continues the same agents and reaches the target", async () => {
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const child = spawn(process.execPath, [join(import.meta.dirname, "support", "child-code-run.ts"), runDir, root], { stdio: "ignore" });
    const results = () => ledgerOf(layout).filter((entry) => entry.type === "result").length;
    await waitFor(() => results() >= 12 && eventsOf(layout).some((event) => event.type === "review"), 60_000);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const killed = loadState(layout.state);
    expect(killed?.finished).toBeNull();
    const liveBefore = Object.keys(killed?.ladder.live ?? {}).map(Number);
    expect(liveBefore.length).toBeGreaterThanOrEqual(2);
    const resultsBefore = results();
    writeFileSync(join(layout.reviewDir, "001-999.jsonl"), "{}\n"); // what a kill in the middle of a review can leave behind
    for (const agent of liveBefore) expect(readFileSync(layout.sessionFile(agent), "utf8").length).toBeGreaterThan(0);

    const model = createScriptedCodeModel({ hints: [], value: (_h, cycle) => cycle * 5, latencyMs: 5 });
    const resumedTask = defineTask({
      name: "kill test",
      mode: "code",
      prompt: "Raise the number in pred.txt.",
      evaluate: async (context) => ({ status: "ok", score: Number(readFileSync(join(context.workDir, "pred.txt"), "utf8")) / 100, metrics: {}, details: "" }),
      metric: { name: "score", direction: "max" },
      review: false,
      branchReview: { everyMinutes: 0.004, maxTurns: 3, maxConcurrent: 2 },
      agents: 4,
      model: { baseUrl: "x", apiKey: "x", model: "x", contextWindow: 1 },
      stop: { targetScore: 0.9 },
      runsDir: root,
    });
    const outcome = await runTask(resumedTask, { createClient: () => model, runDir, resume: true });

    expect(outcome.reason).toBe("target");
    expect(results()).toBeGreaterThan(resultsBefore);
    const resumed = ledgerOf(layout)
      .filter((entry) => entry.type === "lifecycle" && entry.detail === "resumed")
      .map((entry) => entry.agent);
    expect(resumed.sort()).toEqual(liveBefore.sort());
    expect(forks(layout)).toEqual([]);
    // an agent's session holds both lives: the cycles before the kill and after it
    const agent = liveBefore[0] as number;
    expect((readFileSync(layout.sessionFile(agent), "utf8").match(/"toolName":"submit"/g) ?? []).length).toBeGreaterThan(4);
  }, 90_000);
});

describe("Ctrl-C in a code run, as the example scripts handle it", () => {
  it("ends the run in order (run_end stopped, report written, exit code 0) and the hidden file is back", async () => {
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const child = spawn(process.execPath, [join(import.meta.dirname, "support", "child-sigint-run.ts"), runDir, root, truth], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await waitFor(() => ledgerOf(layout).filter((entry) => entry.type === "result").length >= 4, 30_000);
    expect(existsSync(truth)).toBe(false); // hidden while the agents work
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(0);
    expect(output).toContain('"stopped"');
    expect(readFileSync(truth, "utf8")).toBe("1000000");
    expect(eventsOf(layout).at(-1)).toMatchObject({ type: "run_end", reason: "stopped" });
    expect(existsSync(layout.reportHtml)).toBe(true);
  }, 60_000);
});
