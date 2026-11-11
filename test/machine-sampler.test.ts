import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type MachineSample,
  MachineReader,
  machineSampler,
  parseMeminfo,
  peakMemoryPerAgentMb,
  readMachineSamples,
  recommendAgents,
  summarizeByRung,
} from "../src/machine-sampler.ts";
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
    expect(rows[1]).toMatchObject({ samples: 2, loadMean: 10, loadPeak: 12, cpuMean: 0.9, memPeakMb: 30_000, gpuMemPeakMb: null });
  });

  it("measures memory per agent as the growth to the largest reading divided by the agents then alive", () => {
    expect(peakMemoryPerAgentMb([sample({ memUsedMb: 10_000, agents: 1 }), sample({ memUsedMb: 30_000, agents: 10 })])).toBe(2000);
    expect(peakMemoryPerAgentMb([])).toBeUndefined();
    expect(peakMemoryPerAgentMb([sample({ memUsedMb: 10_000 })])).toBeUndefined();
  });
});

describe("the capacity rule of thumb", () => {
  it("is the smallest of cores, memory and the plateau, and says which one decided", () => {
    expect(recommendAgents({ cores: 16, freeMemMb: 90_000 })).toMatchObject({ agents: 16, byMemory: null, limitedBy: "cores" });
    expect(recommendAgents({ cores: 16, coresPerAgent: 4, freeMemMb: 90_000 })).toMatchObject({ agents: 4, limitedBy: "cores" });
    // (40 GB - 8 GB reserve) / 4 GB per agent = 8
    expect(recommendAgents({ cores: 16, freeMemMb: 40 * 1024, peakMemPerAgentMb: 4096 })).toMatchObject({ agents: 8, byMemory: 8, limitedBy: "memory" });
    expect(recommendAgents({ cores: 16, freeMemMb: 90_000, peakMemPerAgentMb: 500, plateauRung: 6 })).toMatchObject({ agents: 6, limitedBy: "plateau" });
  });

  it("never recommends less than one agent", () => {
    expect(recommendAgents({ cores: 16, freeMemMb: 1000, peakMemPerAgentMb: 4096 }).agents).toBe(1);
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
    component.start({ layout, clock, view: { rung: () => rung, agents: () => rung }, note: () => {} });
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

  it("reads the real machine without a command line, path or address in the output", async () => {
    const reading = await new MachineReader().read(1, { rung: 1, agents: 1 });
    expect(Object.keys(reading).sort()).toEqual(
      [
        "agents",
        "cores",
        "cpuBusy",
        "gpuMemUsedMb",
        "gpuUtilPercent",
        "load1",
        "load15",
        "load5",
        "memAvailableMb",
        "memTotalMb",
        "memUsedMb",
        "rung",
        "shells",
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
