/**
 * Characterization of the machine sampler, the run facts, the pressure brake, the history and summary, and the leftover stopper (docs/18 step 1):
 * what they write for a fixed fake machine. The expected output in test/golden/sampler-characterization.json was recorded from the code BEFORE the split of
 * machine-sampler.ts; the refactor must leave this test unchanged and green. To record again on purpose: GOLDEN_UPDATE=1 npx vitest run test/characterization-sampler.test.ts
 *
 * The fake machine: /proc is a temporary directory (the fs functions are redirected for paths under /proc), the operating system numbers (cores, load, memory)
 * are fixed, the nvidia-smi, git and `command -v` calls are answered from a table, the platform is Linux, and time is a FakeClock.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({ root: "", load: [0, 0, 0] as [number, number, number] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const map = <T>(path: T): T =>
    (typeof path === "string" && (path === "/proc" || path.startsWith("/proc/")) && world.root !== ""
      ? `${world.root}${path.slice("/proc".length)}`
      : path) as T;
  return {
    ...actual,
    existsSync: (path: string) => actual.existsSync(map(path)),
    readFileSync: ((path: string, ...rest: never[]) => actual.readFileSync(map(path), ...rest)) as typeof actual.readFileSync,
    readdirSync: ((path: string, ...rest: never[]) => actual.readdirSync(map(path), ...rest)) as typeof actual.readdirSync,
    readlinkSync: ((path: string, ...rest: never[]) => actual.readlinkSync(map(path), ...rest)) as typeof actual.readlinkSync,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    cpus: () => Array.from({ length: 16 }, () => ({}) as never),
    loadavg: () => [...world.load] as [number, number, number],
    totalmem: () => 64 * 1024 ** 3,
    freemem: () => 32 * 1024 ** 3,
    release: () => "mock-release",
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const answer = (file: string, args: string[]): string | undefined => {
    if (file === "nvidia-smi") {
      const query = args[0] ?? "";
      if (query.startsWith("--query-gpu=utilization.gpu")) return "37, 4096\n";
      if (query.startsWith("--query-compute-apps")) return "100, 2048\n101, 512\n";
      if (query === "--query-gpu=name,memory.total") return "Fake GPU 4090, 24564\n";
      if (query === "--query-gpu=memory.total") return "24564\n24564\n";
      return undefined;
    }
    if (file === "git" && args[0] === "rev-parse") return "0123abc\n";
    if (file === "sh" && args[0] === "-c" && /^command -v (renice|flock|nvidia-smi)$/.test(args[1] ?? "")) return "/usr/bin/x\n";
    return undefined;
  };
  const execFile = (file: string, args: string[], ...rest: unknown[]) => {
    const callback = rest.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    const out = answer(file, args);
    queueMicrotask(() => (out === undefined ? callback(new Error("not available"), "", "") : callback(null, out, "")));
    return {} as never;
  };
  return { ...actual, execFile };
});

import { FakeClock } from "./support/fake-clock.ts";

const goldenPath = join(import.meta.dirname, "golden", "sampler-characterization.json");
const recorded: Record<string, unknown> = {};

/** The fake /proc and the run directory. */
let base: string;
let runRoot: string;
const procLine = (pid: number, comm: string, utime: number, stime: number, threads: number, rssPages: number) =>
  `${pid} (${comm}) S 1 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 ${threads} 0 5 1000 ${rssPages} 0`;

function setTick(tick: number): void {
  const proc = world.root;
  const busy = 1000 * (tick + 1);
  writeFileSync(
    join(proc, "stat"),
    `cpu  ${busy} 0 ${busy / 2} ${10_000 + 500 * tick} ${100 * tick} 0 0 ${20 * tick} 0 0\ncpu0 1 1 1 1 1 1 1 1 1 1\nprocs_running ${3 + tick}\n`,
  );
  writeFileSync(join(proc, "meminfo"), `MemTotal:       65536000 kB\nMemFree: 1 kB\nMemAvailable:    ${40_000_000 - 1_000_000 * tick} kB\n`);
  const pressure10 = tick === 1 || tick === 2 ? 55.5 : 5;
  writeFileSync(
    join(proc, "pressure", "cpu"),
    `some avg10=${pressure10.toFixed(2)} avg60=12.50 avg300=3.00 total=99\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
  );
  world.load = [tick === 1 || tick === 2 ? 40 : 2, 20, 10];
  const set = (pid: number, comm: string, utime: number, stime: number, threads: number, rss: number, cwd: string | undefined) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), "stat"), procLine(pid, comm, utime, stime, threads, rss));
    if (cwd !== undefined && !existsSync(join(proc, String(pid), "cwd"))) symlinkSync(cwd, join(proc, String(pid), "cwd"));
  };
  set(501, "python3", 100 + 300 * tick, 50 * tick, 4, 25_600, join(runRoot, "agents", "001"));
  set(502, "bash", 5 * tick, 0, 1, 512, runRoot);
  set(503, "python3", 9000 * tick, 0, 8, 51_200, join(base, "elsewhere"));
  set(504, "bash", 1, 1, 1, 100, undefined); // cwd cannot be read: counted as a shell only
  if (tick >= 2) set(505, "python (x)", 20 * tick, 20, 2, 12_800, join(runRoot, "agents", "002"));
  if (tick >= 4) rmSync(join(proc, "501"), { recursive: true });
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "infinity-characterization-")));
  world.root = join(base, "proc");
  runRoot = join(base, "run");
  mkdirSync(join(world.root, "pressure"), { recursive: true });
  mkdirSync(join(world.root, "sys", "kernel"), { recursive: true });
  mkdirSync(join(world.root, "self"), { recursive: true });
  writeFileSync(join(world.root, "sys", "kernel", "osrelease"), "6.8.0-fake\n");
  writeFileSync(join(world.root, "self", "comm"), "node\n");
  writeFileSync(join(world.root, "self", "stat"), procLine(1, "node", 1, 1, 1, 1));
  mkdirSync(join(runRoot, "agents", "001"), { recursive: true });
  mkdirSync(join(runRoot, "agents", "002"), { recursive: true });
  mkdirSync(join(base, "elsewhere"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  const update = process.env.GOLDEN_UPDATE === "1";
  if (update) writeFileSync(goldenPath, `${JSON.stringify(recorded, null, 2)}\n`);
});

let platform: PropertyDescriptor | undefined;
beforeEach(() => {
  platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
});
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
});

const golden = (): Record<string, unknown> => JSON.parse(readFileSync(goldenPath, "utf8"));
/** Compares with the recorded output (or records it, with GOLDEN_UPDATE=1). */
function check(name: string, value: unknown): void {
  const plain = JSON.parse(JSON.stringify(value));
  recorded[name] = plain;
  if (process.env.GOLDEN_UPDATE === "1") return;
  expect(plain, name).toEqual(golden()[name]);
}

describe("characterization of the sampler and its parts (docs/18 step 1)", () => {
  it("reads the machine twice: the samples, with CPU busy, iowait, steal, the run's own processes and the CPU seconds between the readings", async () => {
    const { MachineReader } = await import("../src/proc-readings.ts");
    setTick(0);
    const reader = new MachineReader({ runRoot, slots: () => ({ cpu: { inUse: 2, waiting: 1 }, gpu: { inUse: 1, waiting: 0 } }) });
    const first = await reader.read(1000, { rung: 4, agents: 4 });
    setTick(1);
    const second = await reader.read(6000, { rung: 4, agents: 4 });
    const noRun = await new MachineReader().read(7000, { rung: 1, agents: 1 }); // without a run directory the run's fields are null
    check("reader", { first, second, noRun });
  });

  it("writes machine.jsonl, run-facts.json and the pressure_hold events through the component, with the hold calls the ladder would get", async () => {
    const { machineSampler } = await import("../src/machine-sampler.ts");
    const layout = (await import("../src/run-layout.ts")).runLayout(runRoot);
    for (const file of [layout.machine, layout.events, join(runRoot, "run-facts.json")]) rmSync(file, { force: true });
    const clock = new FakeClock();
    const holds: boolean[] = [];
    const notes: string[] = [];
    setTick(0);
    const component = machineSampler({
      everyMs: 5000,
      brake: { readings: 2 },
      ceiling: 16,
      commandLine: ["--agents", "16"],
      gate: { enabled: true, cpuSlots: 8, gpuSlots: 2, commandTimeoutMinutes: 120 },
      foreignBusyCores: 1.5,
      needsGpu: true,
      slots: () => ({ cpu: { inUse: Math.floor(clock.now() / 5000), waiting: 1 }, ...(clock.now() >= 10_000 ? { gpu: { inUse: 1, waiting: 0 } } : {}) }),
    });
    component.start({ layout, clock, view: { rung: () => 4, agents: () => 4 }, note: (message) => notes.push(message), hold: (on) => holds.push(on) });
    await clock.advance(0);
    for (let tick = 1; tick <= 5; tick += 1) {
      setTick(tick);
      await clock.advance(5000);
    }
    await component.stop();
    await new Promise((resolve) => setTimeout(resolve, 100)); // the facts are written asynchronously
    const lines = (path: string) =>
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const facts = JSON.parse(readFileSync(join(runRoot, "run-facts.json"), "utf8"));
    facts.node = "<node version>";
    check("component", { machine: lines(layout.machine), events: lines(layout.events), holds, notes, facts });
  });

  it("run facts for a run without a gate and the machine facts of the recommendation", async () => {
    const { readRunFacts } = await import("../src/machine-sampler.ts");
    const { readMachineFacts } = await import("../src/proc-readings.ts");
    setTick(0);
    const bare = await readRunFacts(1234, { commandLine: ["x"] });
    bare.node = "<node version>";
    const full = await readRunFacts(5678, {
      ceiling: 8,
      commandLine: ["--a"],
      gate: { enabled: false, cpuSlots: null, gpuSlots: 3, commandTimeoutMinutes: 30 },
      foreignBusyCores: 0.25,
      needsGpu: false,
    });
    full.node = "<node version>";
    const machine = await readMachineFacts(0);
    check("facts", { bare, full, machine });
  });

  it("the pressure brake: exactly at the limit, three in a row, a low reading in between, release after three low", async () => {
    const { PressureBrake } = await import("../src/pressure-brake.ts");
    const reading = (load1: number, cpuPressure10: number | null) => ({ cores: 16, load1, cpuPressure10 });
    const table: Array<[number, number | null]> = [
      [16, null],
      [16.01, null],
      [20, null],
      [20, 5],
      [20, null],
      [1, 40],
      [1, 40.01],
      [1, 41],
      [1, 90],
      [2, 10],
      [2, 10],
      [30, 10],
      [2, 10],
      [2, 10],
      [2, 10],
      [2, 10],
      [16, 40],
    ];
    const brake = new PressureBrake();
    const trace = table.map(([load, pressure]) => ({
      load,
      pressure,
      over: brake.over(reading(load, pressure)),
      change: brake.update(reading(load, pressure)) ?? null,
      active: brake.active,
    }));
    const custom = new PressureBrake({ loadPerCore: 0.5, pressure10: 10, readings: 1 });
    check("brake", {
      trace,
      custom: [
        custom.update(reading(9, null)) ?? null,
        custom.update(reading(1, 11)) ?? null,
        custom.update(reading(1, 1)) ?? null,
        custom.update(reading(1, 1)) ?? null,
      ],
    });
  });

  it("the summary by rung and the history of a run's samples", async () => {
    const { summarizeByRung, historyFromSamples, peakMemoryPerAgentMb } = await import("../src/machine-summary.ts");
    const samples = JSON.parse(JSON.stringify((recorded.component as { machine: never[] }).machine)) as Array<Record<string, number>>;
    const more = samples.map((sample, index) => ({ ...sample, rung: index < 3 ? 2 : 4, agents: index < 3 ? 2 : 4 }));
    check("summary", {
      byRung: summarizeByRung(more as never),
      history: historyFromSamples(more as never),
      peak: peakMemoryPerAgentMb(more as never),
      none: historyFromSamples([]) ?? null,
    });
  });

  it("the leftover stopper on the same fake /proc: SIGTERM to the processes under the run directory, SIGKILL to the one that stays, one event", async () => {
    const { leftoverStopper } = await import("../src/leftover.ts");
    const layout = (await import("../src/run-layout.ts")).runLayout(runRoot);
    rmSync(layout.events, { force: true });
    setTick(2);
    const signals: Array<[number, string]> = [];
    const stopper = leftoverStopper({
      graceMs: 400,
      sleep: async () => {},
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === 505 && signal === "SIGTERM") rmSync(join(world.root, "505"), { recursive: true }); // ends politely; the others stay
      },
    });
    stopper.start({ layout, clock: new FakeClock(), view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: () => {} });
    await stopper.stop();
    await stopper.stop();
    const events = readFileSync(layout.events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    check("leftover", { signals, events });
  });
});
