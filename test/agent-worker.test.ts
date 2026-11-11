import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WorkerHooks, startWorker } from "../src/agent-worker.ts";
import { realClock } from "../src/clock.ts";
import { Gate } from "../src/gate.ts";
import { runLayout } from "../src/run-layout.ts";
import { MathMode } from "../src/math-mode.ts";
import { isCodeSubmission } from "../src/mode.ts";
import { defineTask } from "../src/task.ts";
import { fakeVerifier } from "./support/fake-verifier.ts";
import { createScriptedModel } from "./support/scripted-model.ts";

/** The setup a math agent gets, with the fake verifier. */
const mathSetup = (hint: string) =>
  new MathMode({
    task: defineTask({
      name: "w",
      mode: "math",
      statement: "True",
      agents: 1,
      model: { baseUrl: "x", apiKey: "x", model: "x", contextWindow: 1 },
      stop: "first-success",
    }),
    leanDir: "unused",
    verifier: fakeVerifier,
  }).agentSetup(hint);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-worker-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(model: ReturnType<typeof createScriptedModel>) {
  const gate = new Gate({ now: realClock.now, sleep: realClock.sleep, defaultPauseMs: 5 });
  const layout = runLayout(join(root, "run"));
  const seen = { replies: 0, activity: 0, submits: [] as Array<{ proved: boolean; steps: number }> };
  const hooks: WorkerHooks = {
    onActivity: () => {
      seen.activity += 1;
    },
    onReply: () => {
      seen.replies += 1;
    },
    onCommit: () => {},
    onDenied: () => {},
    onSubmit: async (submission, info) => {
      if (isCodeSubmission(submission)) throw new Error("a math worker got a code submission");
      seen.submits.push({ proved: submission.verdict.proved, steps: info.steps });
      if (submission.verdict.proved) (await import("node:fs")).writeFileSync(layout.provedMarker(1), "ok");
    },
  };
  const start = (overrides: object = {}) =>
    startWorker({
      number: 1,
      layout,
      client: gate.wrap(model),
      setup: mathSetup("h1"),
      resume: false,
      clock: realClock,
      gate,
      hooks,
      pauseRetryMs: 5,
      ...overrides,
    });
  return { gate, layout, seen, start };
}

describe("agent worker", () => {
  it("runs an agent to a proved submit and ends when its goal is complete", async () => {
    const { start, seen, layout } = setup(createScriptedModel({ hints: ["h1"], isGood: () => true }));
    const worker = start();
    expect(worker.number).toBe(1);
    expect((await worker.done).reason).toBe("done");
    expect(seen.submits).toEqual([{ proved: true, steps: expect.any(Number) }]);
    expect(seen.submits[0]?.steps).toBeGreaterThan(0);
    expect(seen.replies).toBeGreaterThan(0);
    expect(seen.activity).toBeGreaterThan(seen.replies);
    expect(layout.workDir(1)).toContain("agents/001/work");
  });

  it("goes on after a paused run (a throttle that ran out of retries) instead of ending", async () => {
    const base = createScriptedModel({ hints: ["h1"], isGood: () => true });
    let failures = 2;
    const flaky = {
      ...base,
      stream: (request: Parameters<typeof base.stream>[0], signal: AbortSignal) =>
        failures-- > 0 ? throwingStream(new ProviderError("rate_limit", "slow down", 429, 5)) : base.stream(request, signal),
    };
    const { start } = setup(flaky as typeof base);
    expect((await start().done).reason).toBe("done");
  });

  it("ends with a reason and a detail when the agent cannot even be created", async () => {
    const { start, layout } = setup(createScriptedModel({ hints: ["h1"], isGood: () => true }));
    mkdirSync(layout.sessionFile(1), { recursive: true }); // a directory where the session file should be
    const end = await start().done;
    expect(end.reason).toBe("failed");
    expect(end.detail).toBeDefined();
  });

  it("can be cancelled before it has started its first run", async () => {
    const { start } = setup(createScriptedModel({ hints: ["h1"], isGood: () => false, latencyMs: 50 }));
    const worker = start();
    worker.cancel("retire");
    const end = await worker.done;
    expect(end.reason).toBe("cancelled");
    expect(end.cancelled).toBe("retire");
  });

  it("is excused while it is being created, and not once it is running quietly", async () => {
    const { start } = setup(createScriptedModel({ hints: ["h1"], isGood: () => false, latencyMs: 300 }));
    const worker = start();
    expect(worker.excused()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(worker.excused()).toBe(false);
    worker.cancel("finish");
    await worker.done;
  });
});

function throwingStream(error: Error): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) };
}

describe("what a worker does after a run (afterRun)", () => {
  const run = (reason: "done" | "paused" | "error" | "cancelled", extra: { pause?: string; error?: string } = {}) => ({ reason, ...extra }) as never;
  it("rescues, ends cancelled, ends at the breaker, waits after a pause, and otherwise ends with the run's own reason", async () => {
    const { afterRun, MAX_PAUSES_WITHOUT_REPLY } = await import("../src/worker-policy.ts");
    const base = { cancelled: undefined, gateStopped: false, pausesWithoutReply: 0 };
    expect(afterRun({ ...base, cancelled: "rescue", run: run("cancelled") })).toEqual({ type: "rescue" });
    expect(afterRun({ ...base, cancelled: "stuck", run: run("cancelled") })).toEqual({ type: "end", end: { reason: "cancelled", cancelled: "stuck" } });
    expect(afterRun({ ...base, run: run("paused", { pause: "approval" }) })).toMatchObject({ type: "end", end: { reason: "failed" } });
    expect(afterRun({ ...base, run: run("paused", { pause: "provider" }) })).toEqual({ type: "wait" });
    expect(afterRun({ ...base, gateStopped: true, run: run("paused", { pause: "provider" }) })).toMatchObject({ type: "end", end: { reason: "paused" } });
    expect(afterRun({ ...base, pausesWithoutReply: MAX_PAUSES_WITHOUT_REPLY, run: run("paused", { pause: "provider" }) })).toMatchObject({ type: "end" });
    expect(afterRun({ ...base, run: run("error", { error: "boom" }) })).toEqual({ type: "end", end: { reason: "error", detail: "boom" } });
    expect(afterRun({ ...base, run: run("done") })).toEqual({ type: "end", end: { reason: "done" } });
  });
});
