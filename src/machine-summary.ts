import type { History } from "./capacity.ts";
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
  /** CPU pressure, "some" line of /proc/pressure/cpu: share of the time (percent) some task waited for a CPU, averaged over 10 s and 60 s. Null where missing. */
  cpuPressure10: number | null;
  cpuPressure60: number | null;
  /** Tasks runnable now (procs_running of /proc/stat). */
  procsRunning: number | null;
  /** Shares of CPU time (0 to 1) since the last reading spent waiting for disk, and taken by the host (steal). */
  iowaitShare: number | null;
  stealShare: number | null;
  /** The run's own processes: those whose working directory is under the run directory (found by directory, never by name). */
  runProcesses: number | null;
  /** Of those, processes whose program name starts with "python". */
  runPythonProcesses: number | null;
  runThreads: number | null;
  runRssMb: number | null;
  /** CPU seconds (user + system) the run's processes used since the last reading; null for the first reading. Processes that ended in between are not counted. */
  runCpuSeconds: number | null;
  /** The same as cores: CPU seconds divided by the seconds between the two readings. */
  runCpuCores: number | null;
  /** Processes holding GPU memory (any process on the GPU) and the largest single holding, in MB. */
  gpuProcesses: number | null;
  gpuProcMaxMb: number | null;
  /** The CPU slot gate: slots held by running heavy commands and commands waiting for one; null in a run without the gate (and in older records). */
  slotsInUse: number | null;
  slotsWaiting: number | null;
  /** The same for the GPU slots (jobs started with the `gpu` shim). */
  gpuSlotsInUse: number | null;
  gpuSlotsWaiting: number | null;
  /** The run's own view at that moment. */
  rung: number;
  agents: number;
}

// ----- reading a run's record: the rows of the report and the history the recommendation reads -----

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
  /** Mean CPU pressure over 10 s (percent), the run's own CPU use in cores (mean), its memory peak and its python processes (mean and peak); null where not recorded. */
  pressureMean: number | null;
  runCoresMean: number | null;
  runRssPeakMb: number | null;
  jobsMean: number | null;
  jobsPeak: number | null;
  /** Mean slots held and commands waiting at the gate; null without a gate. */
  slotsUseMean: number | null;
  slotsWaitMean: number | null;
  gpuSlotsUseMean: number | null;
  gpuSlotsWaitMean: number | null;
}

const present = (group: readonly MachineSample[], key: keyof MachineSample): number[] =>
  group.flatMap((sample) => {
    const value = sample[key];
    return typeof value === "number" ? [value] : [];
  });
const meanOrNull = (values: number[]): number | null => (values.length > 0 ? mean(values) : null);
const maxOrNull = (values: number[]): number | null => (values.length > 0 ? Math.max(...values) : null);
export const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });

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
        pressureMean: meanOrNull(present(group, "cpuPressure10")),
        runCoresMean: meanOrNull(present(group, "runCpuCores")),
        runRssPeakMb: maxOrNull(present(group, "runRssMb")),
        jobsMean: meanOrNull(present(group, "runPythonProcesses")),
        jobsPeak: maxOrNull(present(group, "runPythonProcesses")),
        slotsUseMean: meanOrNull(present(group, "slotsInUse")),
        slotsWaitMean: meanOrNull(present(group, "slotsWaiting")),
        gpuSlotsUseMean: meanOrNull(present(group, "gpuSlotsInUse")),
        gpuSlotsWaitMean: meanOrNull(present(group, "gpuSlotsWaiting")),
      };
    });
}

/** What one run's readings say about an agent: the CPU cores and the memory it used, and the share of readings in which the run had a python job going. */
export function historyFromSamples(samples: readonly MachineSample[]): History | undefined {
  const cores = samples.flatMap((sample) =>
    sample.runCpuCores !== null && sample.runCpuCores !== undefined && sample.agents > 0 ? [sample.runCpuCores / sample.agents] : [],
  );
  const memory = peakMemoryPerAgentMb(samples);
  const jobs = samples.filter((sample) => sample.agents > 0 && sample.runPythonProcesses !== null && sample.runPythonProcesses !== undefined);
  const heavy = jobs.reduce((sum, sample) => sum + Math.min(1, (sample.runPythonProcesses ?? 0) / sample.agents), 0);
  return cores.length === 0 && memory === undefined
    ? undefined
    : {
        ...optional("cpuPerAgent", cores.length > 0 ? mean(cores) : undefined),
        ...optional("memPerAgentGb", memory === undefined ? undefined : memory / 1024),
        ...optional("heavyShare", jobs.length > 0 && heavy > 0 ? heavy / jobs.length : undefined),
      };
}

/** Peak memory per agent from the readings: how much memory use grew from the first reading to the largest, per agent alive at the largest. */
export function peakMemoryPerAgentMb(samples: readonly MachineSample[]): number | undefined {
  const first = samples[0];
  if (!first) return undefined;
  const top = samples.reduce((best, sample) => (sample.memUsedMb > best.memUsedMb ? sample : best), first);
  return top.agents > 0 && top.memUsedMb > first.memUsedMb ? (top.memUsedMb - first.memUsedMb) / top.agents : undefined;
}
