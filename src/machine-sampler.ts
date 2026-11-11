import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { Clock } from "./clock.ts";
import type { ComponentContext, RunComponent } from "./component.ts";
import { JsonlFile } from "./jsonl.ts";

/** One reading of the machine. Numbers only: no command line, environment, path or address ever enters it. */
export interface MachineSample {
  ts: number;
  cores: number;
  load1: number;
  load5: number;
  load15: number;
  /** Share of CPU time spent busy since the last reading (0 to 1); null for the first reading and where /proc/stat is missing. */
  cpuBusy: number | null;
  memUsedMb: number;
  memAvailableMb: number;
  memTotalMb: number;
  /** Processes whose program name is bash (all of them on the machine; cheap to count, and in a code run almost all belong to the agents). */
  shells: number | null;
  gpuUtilPercent: number | null;
  gpuMemUsedMb: number | null;
  /** The run's own view at that moment. */
  rung: number;
  agents: number;
}

export const SAMPLE_EVERY_MS = 5000;

// ----- parsing (pure) -----

export interface CpuTimes {
  busy: number;
  total: number;
}

/** The first line of /proc/stat ("cpu user nice system idle iowait irq softirq steal ...") as busy and total jiffies. */
export function parseCpuLine(line: string): CpuTimes {
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return { busy: total - idle, total };
}

/** Share of the time between two readings that the CPUs were busy (0 to 1); null without a gap. */
export function busyShare(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  return total > 0 ? (after.busy - before.busy) / total : null;
}

export function parseMeminfo(text: string): { totalMb: number; availableMb: number } {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  return { totalMb: Math.round(kb("MemTotal") / 1024), availableMb: Math.round(kb("MemAvailable") / 1024) };
}

// ----- reading -----

const readIf = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

function countShells(): number | null {
  if (!existsSync("/proc/self/comm")) return null;
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/comm`, "utf8").trim() === "bash") count += 1;
    } catch {
      // the process ended meanwhile
    }
  }
  return count;
}

function readGpu(): Promise<{ util: number; memMb: number } | undefined> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"], { timeout: 4000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const [util, memMb] = stdout.trim().split("\n")[0]?.split(",").map(Number) ?? [];
      resolve(Number.isFinite(util) && Number.isFinite(memMb) ? { util: util as number, memMb: memMb as number } : undefined);
    });
  });
}

/** Reads the machine. Keeps the last CPU reading to compute the busy share; the first call returns null for it. */
export class MachineReader {
  private lastCpu: CpuTimes | undefined;

  async read(now: number, run: { rung: number; agents: number }): Promise<MachineSample> {
    const stat = readIf("/proc/stat");
    const cpu = stat ? parseCpuLine(stat.split("\n")[0] ?? "") : undefined;
    const cpuBusy = cpu && this.lastCpu ? busyShare(this.lastCpu, cpu) : null;
    this.lastCpu = cpu;
    const info = readIf("/proc/meminfo");
    const mem = info ? parseMeminfo(info) : { totalMb: Math.round(totalmem() / 1048576), availableMb: Math.round(freemem() / 1048576) };
    const [load1, load5, load15] = loadavg();
    const gpu = await readGpu();
    return {
      ts: now,
      cores: cpus().length,
      load1: load1 ?? 0,
      load5: load5 ?? 0,
      load15: load15 ?? 0,
      cpuBusy,
      memUsedMb: mem.totalMb - mem.availableMb,
      memAvailableMb: mem.availableMb,
      memTotalMb: mem.totalMb,
      shells: countShells(),
      gpuUtilPercent: gpu?.util ?? null,
      gpuMemUsedMb: gpu?.memMb ?? null,
      rung: run.rung,
      agents: run.agents,
    };
  }
}

// ----- the component -----

export interface MachineSamplerOptions {
  everyMs?: number;
  /** For tests. */
  reader?: Pick<MachineReader, "read">;
}

/** Writes `machine.jsonl` in the run directory every few seconds from the start of the agents to the end of the run. */
export function machineSampler(options: MachineSamplerOptions = {}): RunComponent {
  const stopping = new AbortController();
  let loop: Promise<void> | undefined;
  return {
    name: "machine-sampler",
    start(context: ComponentContext) {
      const reader = options.reader ?? new MachineReader();
      const every = options.everyMs ?? SAMPLE_EVERY_MS;
      const sample = async () => {
        try {
          const line = await reader.read(context.clock.now(), { rung: context.view.rung(), agents: context.view.agents() });
          appendFileSync(context.layout.machine, `${JSON.stringify(line)}\n`);
        } catch (error) {
          context.note(`machine sampler: ${error instanceof Error ? error.message : String(error)}`);
          stopping.abort();
        }
      };
      loop = (async () => {
        await sample();
        while (!stopping.signal.aborted) {
          await sleepOf(context.clock, every, stopping.signal);
          if (stopping.signal.aborted) return;
          await sample();
        }
      })();
    },
    async stop() {
      stopping.abort();
      await loop;
    },
  };
}

const sleepOf = (clock: Clock, ms: number, signal: AbortSignal) => clock.sleep(ms, signal).catch(() => undefined);

// ----- reading a run's record -----

export const readMachineSamples = (path: string): MachineSample[] => new JsonlFile<MachineSample>(path).readAll();

export interface RungMachineRow {
  rung: number;
  samples: number;
  loadMean: number;
  loadPeak: number;
  cpuMean: number | null;
  cpuPeak: number | null;
  memPeakMb: number;
  gpuMemPeakMb: number | null;
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Mean and peak of load, CPU and memory for each rung (the ladder's step at the time of the reading), lowest rung first. */
export function summarizeByRung(samples: readonly MachineSample[]): RungMachineRow[] {
  const byRung = new Map<number, MachineSample[]>();
  for (const sample of samples) byRung.set(sample.rung, [...(byRung.get(sample.rung) ?? []), sample]);
  return [...byRung]
    .sort((a, b) => a[0] - b[0])
    .map(([rung, group]) => {
      const cpu = group.flatMap((sample) => (sample.cpuBusy === null ? [] : [sample.cpuBusy]));
      const gpu = group.flatMap((sample) => (sample.gpuMemUsedMb === null ? [] : [sample.gpuMemUsedMb]));
      return {
        rung,
        samples: group.length,
        loadMean: mean(group.map((sample) => sample.load1)),
        loadPeak: Math.max(...group.map((sample) => sample.load1)),
        cpuMean: cpu.length > 0 ? mean(cpu) : null,
        cpuPeak: cpu.length > 0 ? Math.max(...cpu) : null,
        memPeakMb: Math.max(...group.map((sample) => sample.memUsedMb)),
        gpuMemPeakMb: gpu.length > 0 ? Math.max(...gpu) : null,
      };
    });
}

// ----- the capacity rule of thumb -----

export interface CapacityInput {
  cores: number;
  /** Cores one agent's training job uses (default 1). */
  coresPerAgent?: number;
  /** Memory that was free before the agents started, in MB. */
  freeMemMb: number;
  /** Measured peak memory of one agent, in MB; unknown (undefined) leaves this limit out. */
  peakMemPerAgentMb?: number;
  /** The rung where the first-score time and the score rate stop improving, once known from analysed runs. */
  plateauRung?: number;
}

export interface CapacityHint {
  agents: number;
  byCores: number;
  byMemory: number | null;
  plateau: number | null;
  /** The limit that decided. */
  limitedBy: "cores" | "memory" | "plateau";
}

export const MEMORY_RESERVE_MB = 8 * 1024;

/** A rule of thumb, never applied by itself: the smallest of the CPU limit, the memory limit and the measured plateau. */
export function recommendAgents(input: CapacityInput): CapacityHint {
  const byCores = Math.max(1, Math.floor(input.cores / Math.max(1, input.coresPerAgent ?? 1)));
  const byMemory =
    input.peakMemPerAgentMb && input.peakMemPerAgentMb > 0 ? Math.max(1, Math.floor((input.freeMemMb - MEMORY_RESERVE_MB) / input.peakMemPerAgentMb)) : null;
  const plateau = input.plateauRung ?? null;
  const limits: Array<[CapacityHint["limitedBy"], number]> = [["cores", byCores]];
  if (byMemory !== null) limits.push(["memory", byMemory]);
  if (plateau !== null) limits.push(["plateau", plateau]);
  const [limitedBy, agents] = limits.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return { agents, byCores, byMemory, plateau, limitedBy };
}

/** Peak memory per agent from the readings: how much memory use grew from the first reading to the largest, per agent alive at the largest. */
export function peakMemoryPerAgentMb(samples: readonly MachineSample[]): number | undefined {
  const first = samples[0];
  if (!first) return undefined;
  const top = samples.reduce((best, sample) => (sample.memUsedMb > best.memUsedMb ? sample : best), first);
  return top.agents > 0 && top.memUsedMb > first.memUsedMb ? (top.memUsedMb - first.memUsedMb) / top.agents : undefined;
}
