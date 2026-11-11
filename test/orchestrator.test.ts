import { mathModeWith } from "./support/math-mode-with.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl.ts";
import { runTask } from "../src/orchestrator.ts";
import type { LedgerEntry, RunEvent } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { type MathTask, defineTask } from "../src/task.ts";
import { fakeVerifier } from "./support/fake-verifier.ts";
import { FakeLeanRunner } from "./support/fake-lean-runner.ts";
import { createScriptedModel } from "./support/scripted-model.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-run-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const task = (overrides: Partial<MathTask> = {}) =>
  defineTask({
    name: "parity",
    mode: "math",
    statement: "∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1",
    agents: 4,
    model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
    stop: "first-success",
    runsDir: root,
    ...overrides,
  });

const HINTS = ["h1", "h2", "h3", "h4"];

describe("runTask with scripted agents", () => {
  it("stops at the first accepted proof: marker, ledger, events, report, git history", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: (hint) => hint === "h2" });
    const outcome = await runTask(task(), { createClient: () => model, mode: mathModeWith({ verifier: fakeVerifier }), runDir: join(root, "run") });

    expect(outcome.reason).toBe("proved");
    expect(outcome.proved).toEqual([2]);
    const layout = runLayout(outcome.runDir);
    expect(existsSync(layout.provedMarker(2))).toBe(true);
    expect(existsSync(layout.provedMarker(1))).toBe(false);

    const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
    const submits = ledger.filter((entry) => entry.type === "submit");
    expect(submits.some((entry) => entry.proved && entry.agent === 2 && entry.code.includes("GOOD"))).toBe(true);
    expect(submits.filter((entry) => !entry.proved).every((entry) => entry.reason === "this is a bad proof")).toBe(true);
    expect(ledger.every((entry) => entry.workDir.includes("agents/") && "commit" in entry)).toBe(true);
    const accepted = submits.find((entry) => entry.proved);
    expect(accepted?.commit).toMatch(/^[0-9a-f]{40}$/);

    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.map((event) => event.type)).toContain("rung");
    expect(events.at(-1)).toMatchObject({ type: "run_end", reason: "proved", proved: [2] });

    const csv = readFileSync(layout.leaderboardCsv, "utf8");
    expect(csv.split("\n")[1]).toMatch(/^1,2,true,/);
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("GOOD");
    const savedState = JSON.parse(readFileSync(layout.state, "utf8"));
    expect(savedState.finished).toBe("proved");
    expect(savedState.startedAt).toBeLessThan(events.at(-1)?.ts ?? 0); // the start time is kept, not the time of the last save (found in the first real run)

    const history = execFileSync("git", ["log", "--format=%s"], { cwd: layout.workDir(2) }).toString();
    expect(history).toContain("start");
    expect(history).toContain("turn 1");
    // the commit the ledger points to holds exactly the submitted file
    const committed = execFileSync("git", ["show", `${accepted?.commit}:Proof.lean`], { cwd: layout.workDir(2) }).toString();
    expect(committed).toBe(accepted?.code);
    expect(readFileSync(join(layout.workDir(2), "Statement.lean"), "utf8")).toContain("abbrev Goal");
  });

  it("climbs the ladder while nobody has proved anything, and starts each agent with its own hint", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: (hint, attempt) => hint === "h4" && attempt >= 2 });
    const outcome = await runTask(task(), { createClient: () => model, mode: mathModeWith({ verifier: fakeVerifier }), runDir: join(root, "run") });
    expect(outcome.proved).toEqual([4]);
    const events = new JsonlFile<RunEvent>(runLayout(outcome.runDir).events).readAll();
    const rungs = events.filter((event) => event.type === "rung").map((event) => (event.type === "rung" ? `${event.from}->${event.to}` : ""));
    expect(rungs).toEqual(["1->2", "2->4"]);
  });

  it("keeps going after a proof when the rule is until-stopped, and stops on the user's signal", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: () => true });
    const controller = new AbortController();
    const running = runTask(task({ stop: "until-stopped", agents: 2 }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir: join(root, "run"),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    controller.abort();
    const outcome = await running;
    expect(outcome.reason).toBe("stopped");
    expect(outcome.proved.length).toBeGreaterThan(1);
  }, 20_000);

  it("refuses to start when the task is invalid", () => {
    expect(() => task({ agents: 0 })).toThrow("agents must be");
    expect(() => task({ statement: " " })).toThrow("statement must not be empty");
  });
});

describe("runTask: ends and rescues", () => {
  const fast = { checkEveryMs: 20, pauseRetryMs: 5, replacementWaitMs: 1 };
  const quick = (overrides: Partial<MathTask> = {}) => task({ stuckMinutes: 0.001, ...overrides });

  it("rescues an agent that goes silent, with the rescue message, and the agent then proves", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: () => true, hangs: (_hint, request) => request === 1 });
    const outcome = await runTask(quick({ agents: 1 }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir: join(root, "run"),
      ...fast,
    });
    expect(outcome.reason).toBe("proved");
    const layout = runLayout(outcome.runDir);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.filter((event) => event.type === "rescue")).toEqual([expect.objectContaining({ agent: 1, rescue: 1 })]);
    const session = readFileSync(layout.sessionFile(1), "utf8");
    expect(session).toContain("You seem stuck");
  });

  it("stops an agent that stays stuck after three rescues, and a new agent takes its place", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: (hint) => hint === "h2", hangs: (hint) => hint === "h1" });
    const outcome = await runTask(quick({ agents: 1 }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir: join(root, "run"),
      ...fast,
    });
    expect(outcome.reason).toBe("proved");
    expect(outcome.proved).toEqual([2]);
    const ledger = new JsonlFile<LedgerEntry>(runLayout(outcome.runDir).ledger).readAll();
    const rescued = ledger.filter((entry) => entry.type === "lifecycle" && entry.agent === 1 && entry.event === "rescued");
    expect(rescued).toHaveLength(3);
    expect(ledger.some((entry) => entry.type === "lifecycle" && entry.agent === 1 && entry.event === "stopped")).toBe(true);
    expect(ledger.some((entry) => entry.type === "lifecycle" && entry.agent === 2 && entry.event === "started")).toBe(true);
  });

  it("stops everything when the quota is used up, keeps the sessions and writes the reason", async () => {
    const model = createScriptedModel({
      hints: HINTS,
      isGood: () => false,
      failAgentsWith: new (await import("sakura-agent")).ProviderError("quota", "insufficient balance", 402),
    });
    const outcome = await runTask(task({ agents: 4 }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir: join(root, "run"),
      ...fast,
    });
    expect(outcome.reason).toBe("quota");
    const events = new JsonlFile<RunEvent>(runLayout(outcome.runDir).events).readAll();
    expect(events.filter((event) => event.type === "quota")).toHaveLength(1);
    expect(existsSync(runLayout(outcome.runDir).sessionFile(1))).toBe(true);
  });

  it("stops softly at the token budget, and a resume with a bigger budget carries on and proves", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: (_hint, attempt) => attempt >= 4, tokens: { input: 100, output: 20 } });
    const runDir = join(root, "run");
    const first = await runTask(task({ agents: 1, tokens: 1000 }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir,
      ...fast,
    });
    expect(first.reason).toBe("budget");
    expect(first.tokensUsed).toBeLessThan(1000 + 120);
    expect(first.proved).toEqual([]);

    const second = await runTask(task({ agents: 1, tokens: 100_000 }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir,
      resume: true,
      ...fast,
    });
    expect(second.reason).toBe("proved");
    expect(second.tokensUsed).toBeGreaterThan(first.tokensUsed);
    const ledger = new JsonlFile<LedgerEntry>(runLayout(runDir).ledger).readAll();
    expect(ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "started" && entry.detail === "resumed")).toHaveLength(1);
  });

  it("a budget stop is soft: requests in flight finish, nothing new starts, every agent ends and the run is resumable", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: () => false, latencyMs: 30, tokens: { input: 100, output: 20 } });
    const runDir = join(root, "run");
    const outcome = await runTask(task({ agents: 4, tokens: 3000 }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir,
      ...fast,
    });
    expect(outcome.reason).toBe("budget");
    const requestsAtEnd = model.requestCount;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(model.requestCount).toBe(requestsAtEnd);
    const ledger = new JsonlFile<LedgerEntry>(runLayout(runDir).ledger).readAll();
    const started = ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "started").length;
    const ended = ledger.filter((entry) => entry.type === "lifecycle" && entry.event === "ended").length;
    expect(ended).toBe(started);
    expect(JSON.parse(readFileSync(runLayout(runDir).state, "utf8")).finished).toBe("budget");
  });

  it("gives up when agents keep failing, instead of replacing them forever", async () => {
    const { ProviderError } = await import("sakura-agent");
    const model = createScriptedModel({ hints: HINTS, isGood: () => false, failAgentsWith: new ProviderError("invalid_request", "bad request", 400) });
    const outcome = await runTask(task({ agents: 1 }), {
      createClient: () => model,
      mode: mathModeWith({ verifier: fakeVerifier }),
      runDir: join(root, "run"),
      ...fast,
    });
    expect(outcome.reason).toBe("too many agent failures");
  }, 30_000);

  it("a finished first-success run is not run again on resume", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: () => true });
    const runDir = join(root, "run");
    await runTask(task(), { createClient: () => model, mode: mathModeWith({ verifier: fakeVerifier }), runDir });
    const before = model.requestCount;
    const again = await runTask(task(), { createClient: () => model, mode: mathModeWith({ verifier: fakeVerifier }), runDir, resume: true });
    expect(again.reason).toBe("proved");
    expect(model.requestCount).toBe(before);
  });

  it("refuses to resume a directory that holds no run", async () => {
    await expect(runTask(task(), { runDir: join(root, "nothing"), resume: true, mode: mathModeWith({ verifier: fakeVerifier }) })).rejects.toThrow(
      "Nothing to resume",
    );
  });
});

describe("runTask: start", () => {
  it("creates a run directory under runsDir named after the task when none is given", async () => {
    const model = createScriptedModel({ hints: HINTS, isGood: () => true });
    const outcome = await runTask(task({ name: "My first Task!" }), { createClient: () => model, mode: mathModeWith({ verifier: fakeVerifier }) });
    expect(outcome.runDir.startsWith(join(root, "my-first-task-"))).toBe(true);
    expect(existsSync(runLayout(outcome.runDir).reportHtml)).toBe(true);
  });

  it("writes the failure down and throws when the statement does not compile", async () => {
    const runner = new FakeLeanRunner(() => ({ exitCode: 1, output: "unknown identifier" }));
    const runDir = join(root, "run");
    await expect(
      runTask(task(), { createClient: () => createScriptedModel({ hints: HINTS, isGood: () => true }), mode: mathModeWith({ leanRunner: runner }), runDir }),
    ).rejects.toThrow("statement does not compile");
    const events = new JsonlFile<RunEvent>(runLayout(runDir).events).readAll();
    expect(events.at(-1)).toMatchObject({ type: "run_end" });
    expect(JSON.stringify(events.at(-1))).toContain("failed to start");
  });
});
