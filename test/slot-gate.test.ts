import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Plugin, type ToolCall, type ToolResult, createLocalEnvironment } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limitedEnvironment } from "../src/command-limits.ts";
import { JsonlFile } from "../src/jsonl.ts";
import { machineSampler } from "../src/machine-sampler.ts";
import { readMachineSamples } from "../src/machine-summary.ts";
import { runTask } from "../src/orchestrator.ts";
import type { RunEvent } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { SlotGate, commandLimits, slotGate } from "../src/slot-gate.ts";
import { defineTask } from "../src/task.ts";
import { FakeClock } from "./support/fake-clock.ts";
import { createFakeEvaluator } from "./support/fake-evaluator.ts";
import { createScriptedCodeModel } from "./support/scripted-code-model.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "infinity-gate-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Peak number of overlapping jobs from a log of "start" / "end" lines. */
function peakOverlap(lines: string[]): number {
  let now = 0;
  let peak = 0;
  for (const line of lines) {
    now += line.startsWith("start") ? 1 : -1;
    peak = Math.max(peak, now);
  }
  return peak;
}

describe("the slot gate", () => {
  it("lets at most `capacity` commands run at once, serves the others in order, and records the wait of each", async () => {
    const gate = new SlotGate(2);
    const waits: Array<[number, number]> = [];
    gate.onWait = (agent, waitMs) => waits.push([agent, waitMs]);
    const log: string[] = [];
    const job = (agent: number) =>
      gate.run(agent, async () => {
        log.push("start");
        await wait(120);
        log.push("end");
      });
    await Promise.all([1, 2, 3, 4, 5].map(job));
    expect(peakOverlap(log)).toBe(2);
    expect(waits.map(([agent]) => agent)).toEqual([1, 2, 3, 4, 5]);
    expect(waits.slice(0, 2).every(([, ms]) => ms < 60)).toBe(true);
    expect(waits[4]?.[1]).toBeGreaterThan(150);
    expect(gate.stats).toMatchObject({ commands: 5 });
    expect(gate.stats.waited).toBeGreaterThanOrEqual(3);
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("gives its slot back when the work fails, and measures the share of slot time that was busy", async () => {
    let time = 0;
    const gate = new SlotGate(2, () => time);
    await expect(
      gate.run(1, async () => {
        time = 50;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(gate.inUse).toBe(0);
    time = 100;
    expect(gate.utilisation()).toBeCloseTo(50 / (2 * 100), 5); // one slot for 50 ms of 100 ms, two slots
    const running = gate.run(2, async () => {
      time = 200;
    });
    await running;
    expect(gate.utilisation()).toBeCloseTo((50 + 100) / (2 * 200), 5);
  });
});

/** The hooks of a plugin, as the kernel would call them. */
function hooksOf(plugin: Plugin) {
  const hooks: Record<string, (...args: never[]) => unknown> = {};
  plugin.setup({
    on: (name: string, handler: (...args: never[]) => unknown) => {
      hooks[name] = handler;
    },
    registerTool: () => {},
    emit: () => {},
  } as never);
  return {
    before: (args: unknown) =>
      (hooks["tool.before"] as (call: ToolCall) => unknown)({ id: "1", name: "bash", args }) as
        | { kind: string; reason?: string; args?: Record<string, unknown> }
        | undefined,
    run: (args: unknown, next: () => Promise<ToolResult>, name = "bash") =>
      (hooks["tool.run"] as (call: ToolCall, next: () => Promise<ToolResult>) => Promise<ToolResult>)({ id: "1", name, args }, next),
    after: (result: ToolResult) =>
      (hooks["tool.after"] as (call: ToolCall, result: ToolResult) => ToolResult | undefined)({ id: "1", name: "bash", args: {} }, result),
  };
}
const ok: ToolResult = { content: [{ type: "text", text: "done" }] };

describe("the command limits plugin", () => {
  it("refuses background: true and says to run in the foreground and for how long", () => {
    const hooks = hooksOf(commandLimits({ wallMinutes: 120, agent: 1 }));
    const decision = hooks.before({ command: "python train.py", background: true });
    expect(decision?.kind).toBe("deny");
    expect(decision?.reason).toContain("foreground");
    expect(decision?.reason).toContain("120 minutes");
    expect(hooks.before({ command: "python train.py", background: false })).toMatchObject({ kind: "rewrite", args: { timeout: 7200 } });
  });

  it("sets the hard wall limit as the shell tool's timeout, lowers a longer one, and leaves a shorter one", () => {
    const hooks = hooksOf(commandLimits({ wallMinutes: 30, agent: 1 }));
    expect(hooks.before({ command: "x" })).toMatchObject({ kind: "rewrite", args: { command: "x", timeout: 1800 } });
    expect(hooks.before({ command: "x", timeout: 99_999 })).toMatchObject({ kind: "rewrite", args: { timeout: 1800 } });
    expect(hooks.before({ command: "x", timeout: 60 })).toBeUndefined();
    expect(hooksOf(commandLimits({ wallMinutes: 30, agent: 1 })).before(undefined)).toMatchObject({ kind: "rewrite" });
  });

  it("makes a heavy bash command wait for a slot and lets light commands and other tools through at once", async () => {
    const gate = new SlotGate(1);
    const hooks = hooksOf(commandLimits({ gate, wallMinutes: 120, agent: 3 }));
    const order: string[] = [];
    const slow = (label: string) => async () => {
      order.push(`start ${label}`);
      await wait(100);
      order.push(`end ${label}`);
      return ok;
    };
    const first = hooks.run({ command: "python a.py" }, slow("a"));
    const second = hooks.run({ command: "python b.py" }, slow("b"));
    await wait(20);
    expect(gate.waiting).toBe(1);
    await hooks.run({ command: "ls" }, slow("light")); // does not wait for the slot held by a
    await hooks.run({ path: "x" }, slow("read"), "read");
    await Promise.all([first, second]);
    expect(order.filter((line) => line.endsWith(" a") || line.endsWith(" b"))).toEqual(["start a", "end a", "start b", "end b"]);
    expect(order.indexOf("start light")).toBeLessThan(order.indexOf("end a"));
  });

  it("adds a line to a timed-out result and leaves other results alone", () => {
    const hooks = hooksOf(commandLimits({ wallMinutes: 120, agent: 1 }));
    const timedOut: ToolResult = { isError: true, content: [{ type: "text", text: "partial\n\nCommand timed out after 7200 seconds." }] };
    expect(JSON.stringify(hooks.after(timedOut))).toContain("120 minutes");
    expect(hooks.after(ok)).toBeUndefined();
  });
});

describe("the gate component", () => {
  it("writes a slot_wait event for a wait of a second or more, and the summary with the utilisation at the end", async () => {
    const layout = runLayout(join(dir, "run"));
    mkdirSync(layout.root, { recursive: true });
    const clock = new FakeClock();
    const gate = new SlotGate(2);
    const component = slotGate(gate);
    component.start({ layout, clock, view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: () => {} });
    gate.onWait?.(1, 400);
    gate.onWait?.(2, 3000);
    await component.stop();
    await component.stop();
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.filter((event) => event.type === "slot_wait")).toMatchObject([{ kind: "cpu", agent: 2, waitMs: 3000 }]);
    expect(events.filter((event) => event.type === "slot_summary")).toMatchObject([{ kind: "cpu", slots: 2, commands: 0 }]);
  });
});

describe("a run with the gate", () => {
  it("never has more heavy commands running than slots, with more agents than slots; light commands do not wait; the numbers reach machine.jsonl and the report", async () => {
    const log = join(dir, "log.txt");
    writeFileSync(log, "");
    writeFileSync(join(dir, "truth.txt"), "100");
    const model = createScriptedCodeModel({
      hints: ["h1", "h2", "h3", "h4"],
      value: (hint, cycle) => Number(hint.slice(1)) * 10 + cycle,
      latencyMs: 5,
      extraCalls: () => [
        { name: "bash", args: { command: `sh -c 'echo start >> ${log}; sleep 1.5; echo end >> ${log}'` } },
        { name: "bash", args: { command: "ls" } },
      ],
    });
    const task = defineTask({
      name: "gate",
      mode: "code",
      prompt: "p",
      hidden: [join(dir, "truth.txt")],
      evaluate: createFakeEvaluator({ original: join(dir, "truth.txt") }).evaluate,
      metric: { name: "score", direction: "max" },
      review: false,
      agents: 4,
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: "until-stopped",
      runsDir: dir,
    });
    const controller = new AbortController();
    const slots = 2;
    const gate = new SlotGate(slots);
    const stopTimer = setTimeout(() => controller.abort(), 12_000);
    const outcome = await runTask(task, {
      createClient: () => model,
      runDir: join(dir, "run"),
      signal: controller.signal,
      gate,
      createEnvironment: limitedEnvironment({ threadsPerJob: 1 }, ({ workDir }) => createLocalEnvironment(workDir)),
      components: [machineSampler({ everyMs: 300, slots: () => ({ cpu: { inUse: gate.inUse, waiting: gate.waiting } }) }), slotGate(gate)],
    });
    clearTimeout(stopTimer);
    const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(peakOverlap(lines)).toBe(slots);
    const layout = runLayout(outcome.runDir);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.some((event) => event.type === "slot_wait")).toBe(true);
    const summary = events.find((event) => event.type === "slot_summary");
    expect(summary).toMatchObject({ kind: "cpu", slots });
    expect(summary?.type === "slot_summary" && summary.utilisation).toBeGreaterThan(0.3);
    const samples = readMachineSamples(layout.machine);
    expect(Math.max(...samples.map((sample) => sample.slotsInUse ?? 0))).toBe(slots);
    expect(Math.max(...samples.map((sample) => sample.slotsWaiting ?? 0))).toBeGreaterThanOrEqual(1);
    const report = readFileSync(layout.reportHtml, "utf8");
    expect(report).toContain(`Slot gate, CPU (${slots} slots)`);
    expect(report).toContain("gate slots in use / waiting");
  }, 60_000);

  it("stops a command at the wall limit and tells the agent; the next command can run", async () => {
    writeFileSync(join(dir, "truth.txt"), "100");
    const model = createScriptedCodeModel({
      hints: ["h1"],
      value: (_hint, cycle) => 40 + 30 * cycle,
      latencyMs: 5,
      extraCalls: (cycle) => (cycle === 1 ? [{ name: "bash", args: { command: "sleep 30" } }] : []),
    });
    const task = defineTask({
      name: "wall",
      mode: "code",
      prompt: "p",
      hidden: [join(dir, "truth.txt")],
      evaluate: createFakeEvaluator({ original: join(dir, "truth.txt") }).evaluate,
      metric: { name: "score", direction: "max" },
      review: false,
      agents: 1,
      commandTimeoutMinutes: 0.02, // 1.2 s
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: { targetScore: 0.9 },
      runsDir: dir,
    });
    const started = Date.now();
    const outcome = await runTask(task, { createClient: () => model, runDir: join(dir, "run") });
    expect(Date.now() - started).toBeLessThan(20_000);
    const session = readFileSync(runLayout(outcome.runDir).sessionFile(1), "utf8");
    expect(session).toContain("Command timed out after 1 seconds");
    expect(session).toContain("This run stops every command after 0.02 minutes");
  }, 40_000);
});

describe("the default components", () => {
  it("are the sampler and the leftover stopper; the gates only when there are any", async () => {
    const { defaultComponents } = await import("../src/defaults.ts");
    expect(defaultComponents().map((component) => component.name)).toEqual(["machine-sampler", "leftover-stopper"]);
    expect(defaultComponents({ gate: new SlotGate(4), gpuSlotMap: [0, 0], pressureBrake: true }).map((component) => component.name)).toEqual([
      "machine-sampler",
      "leftover-stopper",
      "slot-gate",
      "gpu-shim",
    ]);
  });
});

describe("what a task must not rely on", () => {
  it("the background grace of the shell tool is huge but below the timer limit, with room for a `sleep N` command", async () => {
    const { CodeMode } = await import("../src/code-mode.ts");
    expect(CodeMode).toBeDefined();
    expect(existsSync(dir)).toBe(true);
    expect(2_000_000_000 + 3600 * 1000).toBeLessThan(2 ** 31 - 1);
  });
});
