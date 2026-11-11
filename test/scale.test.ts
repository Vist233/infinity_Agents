import { mathModeWith } from "./support/math-mode-with.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl.ts";
import { runTask } from "../src/orchestrator.ts";
import type { LedgerEntry, RunEvent } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { loadState } from "../src/run-state.ts";
import { type MathTask, defineTask } from "../src/task.ts";
import { fakeVerifier } from "./support/fake-verifier.ts";
import { createScriptedModel } from "./support/scripted-model.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-scale-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const task = (overrides: Partial<MathTask> = {}) =>
  defineTask({
    name: "scale",
    mode: "math",
    statement: "True",
    agents: 100,
    model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
    stop: "first-success",
    runsDir: root,
    ...overrides,
  });

const HINTS = ["h1", "h2", "h3", "h4"];

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** How many answered submits the agent's session file holds (a submit cut off by a stop gets an 'interrupted' result and no ledger line). */
function submitsInSession(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes('"toolName":"lean"') && (line.includes("Not accepted") || line.includes("proved: the proof"))).length; // not the "interrupted" results of calls cut off by a stop
}

describe("scale with scripted agents", () => {
  it("climbs to 100 agents, all end on the user's stop, and every agent has its directory, session and ledger lines", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: () => false, latencyMs: 800, constantContent: true });
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const controller = new AbortController();
    const running = runTask(task({ stop: "until-stopped" }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir,
      signal: controller.signal,
      checkEveryMs: 1000,
    });
    await waitFor(() => Object.keys(loadState(layout.state)?.ladder.live ?? {}).length === 100, 150_000);
    controller.abort();
    const outcome = await running;

    expect(outcome.reason).toBe("stopped");
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    const rungs = events.filter((event) => event.type === "rung").map((event) => (event.type === "rung" ? `${event.from}->${event.to}` : ""));
    expect(rungs).toEqual(["1->2", "2->4", "4->8", "8->16", "16->32", "32->64", "64->100"]);
    const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
    const started = new Set(ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "started").map((entry) => entry.agent));
    const ended = new Set(ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "ended").map((entry) => entry.agent));
    expect(started.size).toBe(100);
    expect(ended).toEqual(started); // every agent that started has ended
    for (const agent of started) expect(existsSync(layout.sessionFile(agent))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run_end", reason: "stopped" });
  }, 200_000);

  it("finds the provider's limit, holds below it, never exceeds it, and the ledger matches the sessions", async () => {
    const limit = 10;
    const model = createScriptedModel({
      hints: HINTS,
      isGood: (_hint, attempt) => attempt >= 30,
      latencyMs: 40,
      maxConcurrent: limit,
      retryAfterMs: 30,
      constantContent: true,
    });
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const outcome = await runTask(task(), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir,
      checkEveryMs: 500,
      pauseRetryMs: 20,
    });

    expect(outcome.reason).toBe("proved");
    expect(model.peakConcurrent).toBeLessThanOrEqual(limit);
    expect(model.throttled).toBeGreaterThan(0);
    const state = loadState(layout.state);
    expect(state?.ladder.limitRung).toBeGreaterThan(limit);
    expect(state?.ladder.held).toBe(true);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.some((event) => event.type === "rung" && event.reason === "throttle")).toBe(true);
    expect(events.some((event) => event.type === "throttle")).toBe(true);

    const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
    const agents = new Set(ledger.map((entry) => entry.agent));
    for (const agent of agents) {
      const inLedger = ledger.filter((entry) => entry.type === "submit" && entry.agent === agent).length;
      const inSession = submitsInSession(layout.sessionFile(agent));
      expect([inSession, inSession + 1]).toContain(inLedger); // a submit cut off by the stop may be in the ledger only
    }
  }, 120_000);

  it("stops all agents when the quota is used up: one quota event, no more requests, sessions kept", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: () => false, latencyMs: 30, quotaAfter: 300, constantContent: true });
    const runDir = join(root, "run");
    const layout = runLayout(runDir);
    const outcome = await runTask(task(), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir,
      checkEveryMs: 500,
      pauseRetryMs: 20,
    });

    expect(outcome.reason).toBe("quota");
    const afterStop = model.requestCount;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(model.requestCount).toBe(afterStop);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.filter((event) => event.type === "quota")).toHaveLength(1);
    const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
    const started = ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "started").map((entry) => entry.agent);
    const ended = new Set(ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "ended").map((entry) => entry.agent));
    for (const agent of started) expect(ended.has(agent)).toBe(true);
    expect(loadState(layout.state)?.finished).toBe("quota");
  }, 60_000);
});
