import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHost, LinuxHost } from "../src/host.ts";
import { leftoverStopper } from "../src/leftover.ts";
import { machineSampler } from "../src/machine-sampler.ts";
import { type MachineSample, historyFromSamples, peakMemoryPerAgentMb, readMachineSamples, summarizeByRung } from "../src/machine-summary.ts";
import { PressureBrake } from "../src/pressure-brake.ts";
import {
  MachineReader,
  fieldShare,
  parseComputeApps,
  parseCpuLine,
  parseGpuFacts,
  parseMeminfo,
  parsePressure,
  parseProcStat,
  parseProcsRunning,
  scanProcesses,
} from "../src/proc-readings.ts";
import { JsonlFile } from "../src/jsonl.ts";
import type { RunEvent } from "../src/records.ts";
import { runTask } from "../src/orchestrator.ts";
import { runLayout } from "../src/run-layout.ts";
import { defineTask } from "../src/task.ts";
import { FakeClock } from "./support/fake-clock.ts";
import { createFakeEvaluator } from "./support/fake-evaluator.ts";
import { createScriptedCodeModel } from "./support/scripted-code-model.ts";

const sample = (over: Partial<MachineSample>): MachineSample => ({
  ts: 0,
  cores: 16,
  load1: 1,
  load5: 1,
  load15: 1,
  cpuBusy: 0.5,
  memUsedMb: 10_000,
  memAvailableMb: 80_000,
  memTotalMb: 90_000,
  shells: 3,
  gpuUtilPercent: null,
  gpuMemUsedMb: null,
  cpuPressure10: null,
  cpuPressure60: null,
  procsRunning: null,
  iowaitShare: null,
  stealShare: null,
  runProcesses: null,
  runPythonProcesses: null,
  runThreads: null,
  runRssMb: null,
  runCpuSeconds: null,
  runCpuCores: null,
  gpuProcesses: null,
  gpuProcMaxMb: null,
  slotsInUse: null,
  slotsWaiting: null,
  gpuSlotsInUse: null,
  gpuSlotsWaiting: null,
  rung: 1,
  agents: 1,
  ...over,
});

describe("reading and summarising", () => {
  it("parses /proc/meminfo in MB", () => {
    expect(parseMeminfo("MemTotal:       16384000 kB\nMemFree: 1 kB\nMemAvailable:    8192000 kB\n")).toEqual({ totalMb: 16000, availableMb: 8000 });
  });

  it("gives the mean and the peak of load, CPU and memory for each rung, lowest rung first", () => {
    const rows = summarizeByRung([
      sample({ rung: 4, load1: 8, cpuBusy: 0.9, memUsedMb: 20_000 }),
      sample({ rung: 2, load1: 2, cpuBusy: 0.4 }),
      sample({ rung: 2, load1: 4, cpuBusy: 0.6, gpuMemUsedMb: 5000 }),
      sample({ rung: 4, load1: 12, cpuBusy: null, memUsedMb: 30_000 }),
    ]);
    expect(rows.map((row) => row.rung)).toEqual([2, 4]);
    expect(rows[0]).toMatchObject({ samples: 2, loadMean: 3, loadPeak: 4, cpuMean: 0.5, cpuPeak: 0.6, gpuMemPeakMb: 5000 });
    expect(rows[0]).toMatchObject({ pressureMean: null, runCoresMean: null, jobsPeak: null });
    expect(rows[1]).toMatchObject({ samples: 2, loadMean: 10, loadPeak: 12, cpuMean: 0.9, memPeakMb: 30_000, gpuMemPeakMb: null });
  });

  it("measures memory per agent as the growth to the largest reading divided by the agents then alive", () => {
    expect(peakMemoryPerAgentMb([sample({ memUsedMb: 10_000, agents: 1 }), sample({ memUsedMb: 30_000, agents: 10 })])).toBe(2000);
    expect(peakMemoryPerAgentMb([])).toBeUndefined();
    expect(peakMemoryPerAgentMb([sample({ memUsedMb: 10_000 })])).toBeUndefined();
  });
});

const procLine = (pid: number, comm: string, ticks: [number, number], threads: number, rssPages: number) =>
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime vsize rss
  `${pid} (${comm}) S 1 1 1 0 -1 0 0 0 0 0 ${ticks[0]} ${ticks[1]} 0 0 20 0 ${threads} 0 5 1000 ${rssPages} 0`;

describe("the new /proc readings", () => {
  it("parses CPU pressure, runnable tasks, iowait and steal", () => {
    expect(parsePressure("some avg10=1.50 avg60=0.25 avg300=0.10 total=99\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toEqual({
      avg10: 1.5,
      avg60: 0.25,
    });
    expect(parsePressure("")).toBeUndefined();
    expect(parseProcsRunning("cpu  1 2 3\nctxt 5\nprocs_running 37\nprocs_blocked 0\n")).toBe(37);
    expect(parseProcsRunning("cpu  1 2 3\n")).toBeNull();
    const a = parseCpuLine("cpu  100 0 100 700 100 0 0 0 0 0");
    const b = parseCpuLine("cpu  100 0 100 800 200 0 0 100 0 0");
    expect(fieldShare(a, b, "iowait")).toBeCloseTo(100 / 300, 5);
    expect(fieldShare(a, b, "steal")).toBeCloseTo(100 / 300, 5);
    expect(fieldShare(a, a, "steal")).toBeNull();
  });

  it("parses a process stat line, also when the program name holds spaces and parentheses", () => {
    expect(parseProcStat(procLine(10, "python3", [300, 50], 7, 2560))).toEqual({ comm: "python3", ticks: 350, threads: 7, rssPages: 2560 });
    expect(parseProcStat(procLine(11, "a (b) c", [1, 2], 1, 3))).toMatchObject({ comm: "a (b) c", ticks: 3 });
    expect(parseProcStat("garbage")).toBeUndefined();
  });

  it("parses GPU compute processes (count and the largest holding) and the GPU facts", () => {
    expect(parseComputeApps("1234, 2048\n5678, 512\n")).toEqual({ count: 2, maxMb: 2048 });
    expect(parseComputeApps("")).toEqual({ count: 0, maxMb: 0 });
    expect(parseGpuFacts("NVIDIA GeForce RTX 4090, 24564\n")).toEqual({ name: "NVIDIA GeForce RTX 4090", memMb: 24_564 });
    expect(parseGpuFacts("")).toBeUndefined();
  });
});

describe("the process scan on a fake /proc", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "infinity-proc-"))); // /proc shows real paths
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const addProcess = (proc: string, pid: number, stat: string, cwd?: string) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), "stat"), stat);
    if (cwd !== undefined && !existsSync(join(proc, String(pid), "cwd"))) symlinkSync(cwd, join(proc, String(pid), "cwd"));
  };

  const build = () => {
    const proc = join(dir, "proc");
    const run = join(dir, "run");
    mkdirSync(join(run, "agent-1"), { recursive: true });
    mkdirSync(join(dir, "run-other"), { recursive: true });
    mkdirSync(join(proc, "self"), { recursive: true });
    writeFileSync(join(proc, "self", "comm"), "node\n");
    mkdirSync(join(proc, "sys"), { recursive: true }); // not a number: skipped
    addProcess(proc, 100, procLine(100, "python3", [200, 100], 4, 1000), join(run, "agent-1"));
    addProcess(proc, 101, procLine(101, "bash", [10, 0], 1, 100), run);
    addProcess(proc, 102, procLine(102, "python3", [900, 0], 2, 5000), join(dir, "run-other")); // a sibling directory with the same prefix: not the run's
    addProcess(proc, 103, procLine(103, "bash", [1, 1], 1, 50)); // cwd cannot be read: counted as a shell, not as the run's
    return { proc, run };
  };

  it("sums the run's processes by working directory, never by name, and counts shells on the machine", () => {
    const { proc, run } = build();
    const scan = scanProcesses(new LinuxHost({ procDir: proc }), run);
    expect(scan.shells).toBe(2);
    expect(scan.run).toMatchObject({ processes: 2, python: 1, threads: 5 });
    expect(scan.run.rssMb).toBe(Math.round((1100 * 4096) / 1048576));
    expect([...scan.run.ticks]).toEqual([
      [100, 300],
      [101, 10],
    ]);
  });

  it("gives the CPU seconds and cores since the last reading, per process, and null fields where /proc is missing", async () => {
    const { proc, run } = build();
    const reader = new MachineReader({ host: new LinuxHost({ procDir: proc }), runRoot: run });
    const first = await reader.read(0, { rung: 1, agents: 1 });
    expect(first).toMatchObject({ runProcesses: 2, runPythonProcesses: 1, runThreads: 5, runCpuSeconds: null, cpuPressure10: null, procsRunning: null });
    addProcess(proc, 100, procLine(100, "python3", [400, 100], 4, 1000), join(run, "agent-1")); // +200 ticks
    rmSync(join(proc, "101"), { recursive: true }); // ended: not counted
    addProcess(proc, 104, procLine(104, "python3", [50, 50], 1, 10), run); // new: counts from its start, 100 ticks
    const second = await reader.read(10_000, { rung: 1, agents: 1 });
    expect(second.runCpuSeconds).toBeCloseTo(3, 5);
    expect(second.runCpuCores).toBeCloseTo(0.3, 5);
    const none = await new MachineReader({ host: new LinuxHost({ procDir: join(dir, "nowhere") }), runRoot: run }).read(0, { rung: 1, agents: 1 });
    expect(none).toMatchObject({ shells: null, runProcesses: null, cpuPressure10: null, iowaitShare: null, procsRunning: null });
  });
});

describe("the hint from a run's readings", () => {
  it("takes the CPU cores, memory and heavy share per agent from the readings, and nothing from a run that recorded none", () => {
    expect(historyFromSamples([sample({}), sample({ agents: 2 })])).toBeUndefined();
    const history = historyFromSamples([
      sample({ agents: 4, runCpuCores: 2, runPythonProcesses: 2, memUsedMb: 10_000 }),
      sample({ agents: 4, runCpuCores: 4, runPythonProcesses: 4, memUsedMb: 18_000 }),
    ]);
    expect(history).toMatchObject({ cpuPerAgent: 0.75, heavyShare: 0.75 });
    expect(history?.memPerAgentGb).toBeCloseTo(8000 / 4 / 1024, 5);
  });
});

describe("the pressure brake", () => {
  const reading = (load1: number, pressure: number | null = null) => ({ cores: 16, load1, cpuPressure10: pressure });

  it("goes on after three readings in a row over the limit, comes off after three under it, and a single odd reading changes nothing", () => {
    const brake = new PressureBrake();
    expect(brake.update(reading(20))).toBeUndefined();
    expect(brake.update(reading(20))).toBeUndefined();
    expect(brake.update(reading(5))).toBeUndefined(); // the streak is broken
    expect([20, 20, 20].map((load) => brake.update(reading(load)))).toEqual([undefined, undefined, true]);
    expect(brake.active).toBe(true);
    expect(brake.update(reading(20))).toBeUndefined(); // still over: no change to report
    expect([5, 5, 5].map((load) => brake.update(reading(load)))).toEqual([undefined, undefined, false]);
    expect(brake.active).toBe(false);
  });

  it("counts load per core above 1.0 or CPU pressure above 40 as over, and a missing pressure reading as not over", () => {
    const brake = new PressureBrake();
    expect([brake.over(reading(16)), brake.over(reading(16.5)), brake.over(reading(1, 41)), brake.over(reading(1, 40)), brake.over(reading(1, null))]).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(new PressureBrake({ loadPerCore: 0.5, readings: 1 }).update(reading(10))).toBe(true);
  });
});

describe("the pressure brake: edges", () => {
  const reading = (load1: number, pressure: number | null = null, cores = 16) => ({ cores, load1, cpuPressure10: pressure });
  const feed = (brake: PressureBrake, readings: Array<ReturnType<typeof reading>>) => readings.map((entry) => brake.update(entry));

  it("a reading exactly at the limit is not over, for the load per core and for the pressure", () => {
    const brake = new PressureBrake();
    expect(brake.over(reading(16))).toBe(false); // exactly 1.0 per core
    expect(brake.over(reading(16.0001))).toBe(true);
    expect(brake.over(reading(0, 40))).toBe(false);
    expect(brake.over(reading(0, 40.0001))).toBe(true);
    expect(feed(brake, [reading(16), reading(16), reading(16), reading(16)])).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("it takes exactly three readings in a row to go on, and a low reading in between starts the count again", () => {
    const brake = new PressureBrake();
    expect(feed(brake, [reading(40), reading(40), reading(1), reading(40), reading(40)])).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(feed(brake, [reading(40)])).toEqual([true]);
  });

  it("it takes exactly three low readings in a row to go off, and a high reading in between starts the count again", () => {
    const brake = new PressureBrake({ readings: 3 });
    feed(brake, [reading(40), reading(40), reading(40)]);
    expect(brake.active).toBe(true);
    expect(feed(brake, [reading(1), reading(1), reading(40), reading(1), reading(1)])).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(brake.active).toBe(true);
    expect(feed(brake, [reading(1)])).toEqual([false]);
    expect(brake.active).toBe(false);
  });

  it("answers a change once: after going on, more high readings say nothing; after going off, more low readings say nothing", () => {
    const brake = new PressureBrake({ readings: 2 });
    expect(feed(brake, [reading(40), reading(40), reading(40), reading(40)])).toEqual([undefined, true, undefined, undefined]);
    expect(feed(brake, [reading(1), reading(1), reading(1), reading(1)])).toEqual([undefined, false, undefined, undefined]);
  });

  it("either signal is enough, a missing pressure counts as not over, and a machine with no cores is treated as one core", () => {
    const brake = new PressureBrake();
    expect([
      brake.over(reading(1, 90)),
      brake.over(reading(20, 0)),
      brake.over(reading(1, null)),
      brake.over(reading(2, null, 0)),
      brake.over(reading(1, null, 0)),
    ]).toEqual([true, true, false, true, false]);
  });

  it("limits can be changed: a stricter load limit and a single reading", () => {
    const brake = new PressureBrake({ loadPerCore: 0.25, pressure10: 5, readings: 1 });
    // 4 on 16 cores is exactly 0.25 per core (not over); a pressure of 5.1 is over the limit of 5 (on); 5 exactly is not (off)
    expect(feed(brake, [reading(4), reading(3.9, 5.1), reading(1, 5)])).toEqual([undefined, true, false]);
    expect(brake.active).toBe(false);
  });
});

describe("a run with the branch review left out (--no-review, experiment E6)", () => {
  it("writes the note as a warning, shows 'Branch review: off' in the report, and has no review events, no reviews directory and no reviewer request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infinity-noreview-"));
    try {
      writeFileSync(join(dir, "truth.txt"), "100");
      const model = createScriptedCodeModel({ hints: ["h1"], value: (_hint, cycle) => 40 + 30 * cycle });
      const task = defineTask({
        name: "no-review",
        mode: "code",
        prompt: "p",
        hidden: [join(dir, "truth.txt")],
        evaluate: createFakeEvaluator({ original: join(dir, "truth.txt") }).evaluate,
        metric: { name: "score", direction: "max" },
        review: false,
        agents: 1,
        model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
        stop: { targetScore: 0.9 },
        runsDir: dir,
      });
      expect("branchReview" in task).toBe(false);
      const { defaultComponents } = await import("../src/defaults.ts");
      const outcome = await runTask(task, {
        createClient: () => model,
        runDir: join(dir, "run"),
        components: defaultComponents({
          commandLine: ["--no-review"],
          notes: ["Branch review: off (--no-review). No outside reviewer looks at the agents' work."],
        }),
      });
      const layout = runLayout(outcome.runDir);
      const events = new JsonlFile<RunEvent>(layout.events).readAll();
      expect(events.some((event) => event.type === "warning" && event.message.includes("Branch review: off"))).toBe(true);
      expect(events.some((event) => event.type === "review" || event.type === "review_off" || event.type === "review_skips")).toBe(false);
      expect(existsSync(layout.reviewDir)).toBe(false);
      expect(model.branchRequests).toEqual([]);
      expect(readFileSync(layout.reportHtml, "utf8")).toContain("Branch review: off");
      await new Promise((resolve) => setTimeout(resolve, 200)); // run-facts.json is written asynchronously
      expect(JSON.parse(readFileSync(join(layout.root, "run-facts.json"), "utf8")).commandLine).toEqual(["--no-review"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the readers on a FakeHost", () => {
  const stat = (pid: number, comm: string, ticks: number, threads = 1, rss = 256) =>
    `${pid} (${comm}) S 1 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 ${threads} 0 5 1000 ${rss} 0`;

  it("the reader takes every figure from the host: cores, load, memory, pressure, CPU shares, the run's processes, the GPU", async () => {
    const host = new FakeHost({
      cores: 8,
      load: [3, 2, 1],
      files: {
        stat: "cpu  100 0 100 700 100 0 0 0\nprocs_running 5\n",
        meminfo: "MemTotal: 8192000 kB\nMemAvailable: 2048000 kB\n",
        "pressure/cpu": "some avg10=7.50 avg60=3.00 avg300=1.00 total=1\n",
      },
      processes: [
        { pid: 10, stat: stat(10, "python3", 200, 4, 2560), cwd: "/runs/r1/agents/001" },
        { pid: 11, stat: stat(11, "bash", 10), cwd: "/runs/r1" },
        { pid: 12, stat: stat(12, "python3", 999), cwd: "/runs/other" },
      ],
      gpu: { "--query-gpu=utilization.gpu,memory.used": "50, 1000\n", "--query-compute-apps=pid,used_memory": "9, 300\n" },
    });
    const reader = new MachineReader({ host, runRoot: "/runs/r1" });
    const first = await reader.read(0, { rung: 2, agents: 2 });
    expect(first).toMatchObject({
      cores: 8,
      load1: 3,
      memTotalMb: 8000,
      memAvailableMb: 2000,
      cpuPressure10: 7.5,
      procsRunning: 5,
      shells: 1,
      runProcesses: 2,
      runPythonProcesses: 1,
      runThreads: 5,
      gpuUtilPercent: 50,
      gpuMemUsedMb: 1000,
      gpuProcesses: 1,
      gpuProcMaxMb: 300,
      cpuBusy: null,
      runCpuSeconds: null,
    });
    host.state.files.stat = "cpu  200 0 200 750 100 0 0 0\nprocs_running 6\n";
    host.state.processes[0] = { pid: 10, stat: stat(10, "python3", 400, 4, 2560), cwd: "/runs/r1/agents/001" };
    const second = await reader.read(10_000, { rung: 2, agents: 2 });
    expect(second.cpuBusy).toBeCloseTo(200 / 250, 5);
    expect(second.runCpuSeconds).toBeCloseTo(2, 5);
    expect(second.runCpuCores).toBeCloseTo(0.2, 5);
  });

  it("without /proc and without a GPU tool the reader falls back to the operating system's figures and leaves the rest null", async () => {
    const host = new FakeHost({ proc: false, cores: 2, totalMemoryBytes: 4 * 1024 ** 3, freeMemoryBytes: 1024 ** 3 });
    const reading = await new MachineReader({ host, runRoot: "/runs/r1" }).read(5, { rung: 1, agents: 1 });
    expect(reading).toMatchObject({
      cores: 2,
      memTotalMb: 4096,
      memAvailableMb: 1024,
      memUsedMb: 3072,
      shells: null,
      runProcesses: null,
      cpuPressure10: null,
      procsRunning: null,
      gpuUtilPercent: null,
      gpuProcesses: null,
    });
  });

  it("the leftover stopper signals through the host: SIGTERM to the processes under the run directory, SIGKILL to the ones that stay, never this process", async () => {
    const host = new FakeHost({
      processes: [
        { pid: 20, stat: stat(20, "python3", 1), cwd: "/runs/r1/agents/001" },
        { pid: 21, stat: stat(21, "sleep", 1), cwd: "/runs/r1" },
        { pid: 22, stat: stat(22, "sleep", 1), cwd: "/runs/r10" },
        { pid: process.pid, stat: stat(process.pid, "node", 1), cwd: "/runs/r1" },
      ],
      onSignal: (pid, signal, self) => {
        if (pid === 20 && signal === "SIGTERM") self.end(20);
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "infinity-leftover-"));
    try {
      const layout = runLayout("/runs/r1");
      const events: unknown[] = [];
      const stopper = leftoverStopper({ host, graceMs: 400, sleep: async () => {} });
      // the run directory of this test is the fake path, so the events go to a real directory
      stopper.start({
        layout: { ...layout, events: join(dir, "events.jsonl") },
        clock: new FakeClock(),
        view: { rung: () => 1, agents: () => 1 },
        note: () => {},
        hold: () => {},
      });
      await stopper.stop();
      expect(host.signals).toEqual([
        [20, "SIGTERM"],
        [21, "SIGTERM"],
        [21, "SIGKILL"],
      ]);
      events.push(...new JsonlFile<RunEvent>(join(dir, "events.jsonl")).readAll());
      expect(events).toEqual([{ type: "leftover_processes", ts: 0, found: 2, killedHard: 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the leftover stopper does nothing, and says nothing, on a host without /proc", async () => {
    const host = new FakeHost({ proc: false });
    const dir = mkdtempSync(join(tmpdir(), "infinity-leftover-"));
    try {
      const stopper = leftoverStopper({ host });
      stopper.start({
        layout: { ...runLayout("/runs/r1"), events: join(dir, "events.jsonl") },
        clock: new FakeClock(),
        view: { rung: () => 1, agents: () => 1 },
        note: () => {},
        hold: () => {},
      });
      await stopper.stop();
      expect(host.signals).toEqual([]);
      expect(new JsonlFile<RunEvent>(join(dir, "events.jsonl")).readAll()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the component", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "infinity-machine-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a line at the start and then one per interval, with the run's rung and agents, and stops cleanly", async () => {
    const clock = new FakeClock();
    const layout = runLayout(join(dir, "run"));
    mkdirSync(layout.root, { recursive: true });
    let rung = 1;
    const component = machineSampler({ everyMs: 5000, reader: { read: async (now, run) => sample({ ts: now, rung: run.rung, agents: run.agents }) } });
    component.start({ layout, clock, view: { rung: () => rung, agents: () => rung }, note: () => {}, hold: () => {} });
    await clock.advance(0);
    rung = 2;
    await clock.advance(5000);
    await clock.advance(5000);
    await component.stop();
    await component.stop(); // safe to repeat
    const lines = readMachineSamples(layout.machine);
    expect(lines.map((line) => [line.ts, line.rung])).toEqual([
      [0, 1],
      [5000, 2],
      [10_000, 2],
    ]);
  });

  it("writes run-facts.json once at the start, with the ceiling and the flags it was given", async () => {
    const clock = new FakeClock();
    const layout = runLayout(join(dir, "run"));
    mkdirSync(layout.root, { recursive: true });
    const component = machineSampler({ reader: { read: async (now, run) => sample({ ts: now, ...run }) }, ceiling: 16, commandLine: ["--agents", "16"] });
    component.start({ layout, clock, view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: () => {} });
    await clock.advance(0);
    await component.stop();
    await new Promise((resolve) => setTimeout(resolve, 200)); // the facts read nvidia-smi and git on real time
    const facts = JSON.parse(readFileSync(join(layout.root, "run-facts.json"), "utf8"));
    expect(Object.keys(facts).sort()).toEqual([
      "ceiling",
      "commandLine",
      "commit",
      "cores",
      "foreignBusyCores",
      "gate",
      "gpuMemTotalMb",
      "gpuName",
      "kernel",
      "memTotalMb",
      "node",
      "ts",
      "unsupported",
    ]);
    expect(facts).toMatchObject({ ceiling: 16, commandLine: ["--agents", "16"], node: process.version });
    expect(facts.cores).toBeGreaterThan(0);
  });

  it("holds the ladder through the context and writes pressure_hold once per change when the brake is on", async () => {
    const clock = new FakeClock();
    const layout = runLayout(join(dir, "run"));
    mkdirSync(layout.root, { recursive: true });
    const holds: boolean[] = [];
    let load = 40;
    const component = machineSampler({
      everyMs: 1000,
      brake: { readings: 2 },
      facts: async () => ({}) as never,
      reader: { read: async (now, run) => sample({ ts: now, load1: load, cpuPressure10: 10, ...run }) },
    });
    component.start({ layout, clock, view: { rung: () => 4, agents: () => 4 }, note: () => {}, hold: (on) => holds.push(on) });
    await clock.advance(0);
    await clock.advance(1000); // second reading over the limit: on
    await clock.advance(1000);
    load = 2;
    await clock.advance(1000);
    await clock.advance(1000); // second reading under it: off
    await clock.advance(1000);
    await component.stop();
    expect(holds).toEqual([true, false]);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events).toMatchObject([
      { type: "pressure_hold", on: true, rung: 4, loadPerCore: 2.5 },
      { type: "pressure_hold", on: false, rung: 4, loadPerCore: 0.125 },
    ]);
  });

  it("without a brake it never holds", async () => {
    const clock = new FakeClock();
    const layout = runLayout(join(dir, "run"));
    mkdirSync(layout.root, { recursive: true });
    const holds: boolean[] = [];
    const component = machineSampler({
      everyMs: 1000,
      facts: async () => ({}) as never,
      reader: { read: async (now, run) => sample({ ts: now, load1: 99, ...run }) },
    });
    component.start({ layout, clock, view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: (on) => holds.push(on) });
    await clock.advance(3000);
    await component.stop();
    expect(holds).toEqual([]);
  });

  it("reads the real machine without a command line, path or address in the output", async () => {
    const reading = await new MachineReader().read(1, { rung: 1, agents: 1 });
    expect(Object.keys(reading).sort()).toEqual(
      [
        "agents",
        "cores",
        "cpuBusy",
        "cpuPressure10",
        "cpuPressure60",
        "gpuMemUsedMb",
        "gpuProcMaxMb",
        "gpuProcesses",
        "gpuUtilPercent",
        "iowaitShare",
        "procsRunning",
        "runCpuCores",
        "runCpuSeconds",
        "runProcesses",
        "runPythonProcesses",
        "runRssMb",
        "runThreads",
        "stealShare",
        "load1",
        "load15",
        "load5",
        "memAvailableMb",
        "memTotalMb",
        "memUsedMb",
        "rung",
        "shells",
        "gpuSlotsInUse",
        "gpuSlotsWaiting",
        "slotsInUse",
        "slotsWaiting",
        "ts",
      ].sort(),
    );
    expect(reading.cores).toBeGreaterThan(0);
  });

  it("a run writes machine.jsonl and its report has the machine section", async () => {
    const evaluator = createFakeEvaluator({ original: join(dir, "truth.txt") });
    writeFileSync(join(dir, "truth.txt"), "100");
    const model = createScriptedCodeModel({ hints: ["h1", "h2"], value: (hint, cycle) => Number(hint.slice(1)) * 40 + 30 * cycle });
    const task = defineTask({
      name: "machine",
      mode: "code",
      prompt: "p",
      hidden: [join(dir, "truth.txt")],
      evaluate: evaluator.evaluate,
      metric: { name: "score", direction: "max" },
      review: false,
      agents: 2,
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: { targetScore: 0.9 },
      runsDir: dir,
    });
    const outcome = await runTask(task, { createClient: () => model, runDir: join(dir, "run") });
    const layout = runLayout(outcome.runDir);
    expect(readMachineSamples(layout.machine).length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("Machine by rung");
  }, 60_000);
});
