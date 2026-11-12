import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEnvironment } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limitCommands } from "../src/command-limits.ts";
import { JsonlFile } from "../src/jsonl.ts";
import { leftoverStopper, processesUnder } from "../src/leftover.ts";
import { LinuxHost } from "../src/host.ts";
import { MachineReader, readMachineFacts, scanProcesses } from "../src/proc-readings.ts";
import { unsupportedFeatures } from "../src/platform.ts";
import type { RunEvent } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { FakeClock } from "./support/fake-clock.ts";

/**
 * Tests that need the real thing: the real /proc, a real renice of a child, a real process-group kill, a real cleanup of leftover processes.
 * They run on Linux (the server) and are skipped everywhere else; the unit tests with fake /proc trees run on any system.
 */
const onLinux = process.platform === "linux";

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "infinity-linux-")));
});
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-(child.pid ?? 0), "SIGKILL");
    } catch {
      // gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
};
/** A sleeping process in its own process group whose working directory is `cwd`. */
const sleeper = (cwd: string, seconds = 60): ChildProcess => {
  const child = spawn("sleep", [String(seconds)], { cwd, detached: true, stdio: "ignore" });
  children.push(child);
  return child;
};

describe.skipIf(!onLinux)("[Linux only, skipped on other systems] the real /proc", () => {
  it("scans the real /proc: finds a child by its working directory under the run directory, not by name, and not a sibling directory", async () => {
    const root = join(dir, "run");
    mkdirSync(join(root, "agents", "001"), { recursive: true });
    mkdirSync(join(dir, "run-other"));
    const inside = sleeper(join(root, "agents", "001"));
    const outside = sleeper(join(dir, "run-other"));
    await wait(200);
    const scan = scanProcesses(new LinuxHost(), root);
    expect(scan.run.ticks.has(inside.pid ?? 0)).toBe(true);
    expect(scan.run.ticks.has(outside.pid ?? 0)).toBe(false);
    expect(scan.run.processes).toBeGreaterThanOrEqual(1);
    expect(processesUnder(root)).toContain(inside.pid);
    expect(processesUnder(root)).not.toContain(outside.pid);
  });

  it("the machine reader reads pressure, runnable tasks, iowait and steal from the real files, and the run's CPU seconds between two readings", async () => {
    const root = join(dir, "run");
    mkdirSync(root);
    const burner = spawn("sh", ["-c", "while :; do :; done"], { cwd: root, detached: true, stdio: "ignore" });
    children.push(burner);
    const reader = new MachineReader({ runRoot: root });
    await reader.read(Date.now(), { rung: 1, agents: 1 });
    await wait(1200);
    const second = await reader.read(Date.now(), { rung: 1, agents: 1 });
    expect(second.procsRunning).toBeGreaterThanOrEqual(1);
    expect(second.iowaitShare).not.toBeNull();
    expect(second.stealShare).not.toBeNull();
    expect(second.runProcesses).toBeGreaterThanOrEqual(1);
    expect(second.runCpuCores ?? 0).toBeGreaterThan(0.3);
    expect(second.runCpuCores ?? 0).toBeLessThan(2.5);
    if (existsSync("/proc/pressure/cpu")) expect(second.cpuPressure10).not.toBeNull(); // the kernel may be built without it
    const facts = await readMachineFacts(200);
    expect(facts.cores).toBeGreaterThan(0);
    expect(facts.busyCores).toBeGreaterThanOrEqual(0);
  });

  it("a real platform check on this machine finds renice and /proc", async () => {
    expect(await unsupportedFeatures()).toEqual([]);
  });
});

describe.skipIf(!onLinux)("[Linux only, skipped on other systems] real renice and process groups", () => {
  it("a command through the limits runs at a higher niceness than its parent, and its children too", async () => {
    const env = limitCommands(createLocalEnvironment(dir), { threadsPerJob: 2, niceLevel: 7 });
    const mine = Number(
      (await new Promise<string>((resolve) => spawn("ps", ["-o", "ni=", "-p", String(process.pid)]).stdout.on("data", (d) => resolve(String(d))))).trim(),
    );
    const result = await env.exec("ps -o ni= -p $$; sh -c 'ps -o ni= -p $$'", { cwd: dir });
    const [shell, child] = result.output
      .trim()
      .split("\n")
      .map((text) => Number(text.trim()));
    // Linux renice sets the niceness to the value given (macOS adds it); a niceness already above it stays
    expect(shell).toBe(Math.max(mine, 7));
    expect(child).toBe(Math.max(mine, 7));
  });

  it("the wall limit of a command stops its whole process group in a real run: the grandchild is gone too", async () => {
    const { runTask } = await import("../src/orchestrator.ts");
    const { defineTask } = await import("../src/task.ts");
    const { createFakeEvaluator } = await import("./support/fake-evaluator.ts");
    const { createScriptedCodeModel } = await import("./support/scripted-code-model.ts");
    writeFileSync(join(dir, "truth.txt"), "100");
    const marker = join(dir, "pids.txt");
    const model = createScriptedCodeModel({
      hints: ["h1"],
      value: (_hint, cycle) => 40 + 30 * cycle,
      latencyMs: 5,
      extraCalls: (cycle) => (cycle === 1 ? [{ name: "bash", args: { command: `sh -c 'sleep 60 & echo $! >> ${marker}; wait'` } }] : []),
    });
    const task = defineTask({
      name: "group",
      mode: "code",
      prompt: "p",
      hidden: [join(dir, "truth.txt")],
      evaluate: createFakeEvaluator({ original: join(dir, "truth.txt") }).evaluate,
      metric: { name: "score", direction: "max" },
      review: false,
      agents: 1,
      commandTimeoutMinutes: 0.02,
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: { targetScore: 0.9 },
      runsDir: dir,
    });
    await runTask(task, { createClient: () => model, runDir: join(dir, "run"), components: [] });
    await wait(500);
    const pids = readFileSync(marker, "utf8").trim().split("\n").map(Number);
    expect(pids.length).toBe(1);
    for (const pid of pids) expect(alive(pid), `pid ${pid}`).toBe(false);
  }, 40_000);

  it("the leftover stopper stops a real process that has the run directory as its working directory, and leaves one outside; one event says how many", async () => {
    const root = join(dir, "run");
    mkdirSync(join(root, "agents", "001"), { recursive: true });
    mkdirSync(join(dir, "elsewhere"));
    const inside = sleeper(join(root, "agents", "001"));
    const outside = sleeper(join(dir, "elsewhere"));
    await wait(200);
    const layout = runLayout(root);
    const stopper = leftoverStopper({ graceMs: 3000 });
    stopper.start({ layout, clock: new FakeClock(), view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: () => {} });
    await stopper.stop();
    await wait(300);
    expect(alive(inside.pid ?? 0)).toBe(false);
    expect(alive(outside.pid ?? 0)).toBe(true);
    expect(new JsonlFile<RunEvent>(layout.events).readAll()).toMatchObject([{ type: "leftover_processes", found: 1, killedHard: 0 }]);
  }, 20_000);

  it("a process that ignores SIGTERM is killed hard after the grace time", async () => {
    const root = join(dir, "run");
    mkdirSync(root);
    const stubborn = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { cwd: root, detached: true, stdio: "ignore" });
    children.push(stubborn);
    await wait(300);
    const layout = runLayout(root);
    const stopper = leftoverStopper({ graceMs: 600 });
    stopper.start({ layout, clock: new FakeClock(), view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: () => {} });
    await stopper.stop();
    await wait(300);
    expect(alive(stubborn.pid ?? 0)).toBe(false);
    // the shell's `sleep 1` children share its working directory, so one or two processes may be found at that moment; the shell itself is always killed hard
    const [event] = new JsonlFile<RunEvent>(layout.events).readAll() as Array<RunEvent & { found: number; killedHard: number }>;
    expect(event?.type).toBe("leftover_processes");
    expect(event?.found).toBeGreaterThanOrEqual(1);
    expect(event?.killedHard).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
