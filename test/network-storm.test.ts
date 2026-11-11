import { mathModeWith } from "./support/math-mode-with.ts";
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LlmClient, ProviderError } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gate, type GateEvent } from "../src/gate.ts";
import { JsonlFile } from "../src/jsonl.ts";
import { CONNECT_ATTEMPT_TIMEOUT_MS, allowSlowConnects } from "../src/network.ts";
import { runTask } from "../src/orchestrator.ts";
import type { LedgerEntry, RunEvent } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { defineTask } from "../src/task.ts";
import { fakeVerifier } from "./support/fake-verifier.ts";
import { createScriptedModel } from "./support/scripted-model.ts";

const request = { system: "s", messages: [], tools: [] };
const failing = (error: ProviderError): LlmClient => ({
  model: { id: "x", contextWindow: 1000, supportsImages: false },
  // biome-ignore lint/correctness/useYield: the request fails on purpose
  async *stream() {
    throw error;
  },
});
async function fail(gated: LlmClient): Promise<void> {
  try {
    for await (const _event of gated.stream(request, new AbortController().signal));
  } catch {
    // expected
  }
}

describe("connection errors in a cluster", () => {
  it("one or a few do not pause anybody; a cluster pauses everybody once, as a throttle caused by the connection", async () => {
    const time = 0;
    const events: GateEvent[] = [];
    const gate = new Gate({
      now: () => time,
      sleep: async () => {},
      defaultPauseMs: 5000,
      onEvent: (event) => events.push(event),
      connectionErrors: 5,
      connectionWindowMs: 10_000,
    });
    const gated = gate.wrap(failing(new ProviderError("network", "fetch failed")));
    for (let i = 0; i < 4; i += 1) await fail(gated);
    expect(events.filter((event) => event.type === "throttle")).toHaveLength(0);
    expect(gate.paused).toBe(false);
    await fail(gated);
    expect(events.filter((event) => event.type === "throttle")).toEqual([{ type: "throttle", delayMs: 5000, pausedUntil: 5000, cause: "connection" }]);
    expect(gate.paused).toBe(true);
  });

  it("errors that are far apart in time do not add up", async () => {
    let time = 0;
    const events: GateEvent[] = [];
    const gate = new Gate({
      now: () => time,
      sleep: async () => {},
      defaultPauseMs: 5000,
      onEvent: (event) => events.push(event),
      connectionErrors: 3,
      connectionWindowMs: 1000,
    });
    const gated = gate.wrap(failing(new ProviderError("network", "fetch failed")));
    for (let i = 0; i < 6; i += 1) {
      time += 600;
      await fail(gated);
    }
    expect(events.filter((event) => event.type === "throttle")).toHaveLength(0);
  });

  it("other errors (invalid request) never count as connection errors", async () => {
    const events: GateEvent[] = [];
    const gate = new Gate({ now: () => 0, sleep: async () => {}, defaultPauseMs: 5000, onEvent: (event) => events.push(event), connectionErrors: 2 });
    const gated = gate.wrap(failing(new ProviderError("invalid_request", "bad", 400)));
    for (let i = 0; i < 5; i += 1) await fail(gated);
    expect(events).toEqual([]);
  });
});

describe("connect attempt timeout", () => {
  it("is set to five seconds by allowSlowConnects and by every runTask", async () => {
    const before = getDefaultAutoSelectFamilyAttemptTimeout();
    try {
      setDefaultAutoSelectFamilyAttemptTimeout(250);
      allowSlowConnects();
      expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
      expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBe(5000);
    } finally {
      setDefaultAutoSelectFamilyAttemptTimeout(before);
    }
  });
});

describe("no restart storm when every agent fails with a connection error", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "infinity-storm-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("replacements wait (1 s, 2 s, 4 s ...), so a few seconds start a handful of agents and requests, not hundreds", async () => {
    const model = createScriptedModel({ hints: ["h1"], isGood: () => false, failAgentsWith: new ProviderError("network", "fetch failed") });
    const task = defineTask({
      name: "storm",
      mode: "math",
      statement: "True",
      agents: 4,
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: "first-success",
      runsDir: root,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 4000);
    const outcome = await runTask(task, {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir: join(root, "run"),
      signal: controller.signal,
      checkEveryMs: 500,
      pauseRetryMs: 50,
    });
    const layout = runLayout(outcome.runDir);
    const started = new JsonlFile<LedgerEntry>(layout.ledger).readAll().filter((entry) => entry.type === "lifecycle" && entry.event === "started").length;
    expect(started).toBeLessThanOrEqual(6); // without the wait this is in the hundreds
    expect(model.requestCount).toBeLessThanOrEqual(8); // one planner call and a handful of agent requests, not a storm
    expect(new JsonlFile<RunEvent>(layout.events).readAll().at(-1)).toMatchObject({ type: "run_end", reason: "stopped" });
  }, 20_000);
});

describe("the waits", () => {
  it("a replacement waits base, 2 x base, 4 x base ... up to a minute after failures, and not at all after a normal end", async () => {
    const { replacementWait } = await import("../src/backoff.ts");
    expect(replacementWait(false, 5)).toBe(0);
    expect([1, 2, 3, 4].map((failures) => replacementWait(true, failures))).toEqual([1000, 2000, 4000, 8000]);
    expect(replacementWait(true, 40)).toBe(60_000);
    expect(replacementWait(true, 3, 10)).toBe(40);
  });

  it("the cluster detector fires when enough events fall in the window and then counts again", async () => {
    const { ClusterDetector } = await import("../src/error-cluster.ts");
    const cluster = new ClusterDetector(3, 100);
    expect([0, 10, 20].map((time) => cluster.note(time))).toEqual([false, false, true]);
    expect(cluster.note(30)).toBe(false);
    expect([500, 700].map((time) => cluster.note(time))).toEqual([false, false]);
  });
});
