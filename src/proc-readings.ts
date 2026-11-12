import type { MachineFacts } from "./capacity.ts";
import { type Host, LinuxHost } from "./host.ts";
import type { MachineSample } from "./machine-summary.ts";

// ----- parsing (pure) -----

export interface CpuTimes {
  busy: number;
  total: number;
  iowait: number;
  steal: number;
}

/** The first line of /proc/stat ("cpu user nice system idle iowait irq softirq steal ...") as busy and total jiffies. */
export function parseCpuLine(line: string): CpuTimes {
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return { busy: total - idle, total, iowait: fields[4] ?? 0, steal: fields[7] ?? 0 };
}

/** Share (0 to 1) of the time between two readings taken by a field of the CPU line (iowait or steal); null without a gap. */
export function fieldShare(before: CpuTimes, after: CpuTimes, field: "iowait" | "steal"): number | null {
  const total = after.total - before.total;
  return total > 0 ? (after[field] - before[field]) / total : null;
}

/** `procs_running` of /proc/stat. */
export function parseProcsRunning(text: string): number | null {
  const value = /^procs_running\s+(\d+)/m.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

/** The "some" line of /proc/pressure/cpu ("some avg10=0.12 avg60=0.34 avg300=0.50 total=123"). */
export function parsePressure(text: string): { avg10: number; avg60: number } | undefined {
  const line = text.split("\n").find((candidate) => candidate.startsWith("some "));
  const avg10 = /avg10=([\d.]+)/.exec(line ?? "")?.[1];
  const avg60 = /avg60=([\d.]+)/.exec(line ?? "")?.[1];
  return avg10 === undefined || avg60 === undefined ? undefined : { avg10: Number(avg10), avg60: Number(avg60) };
}

export interface ProcStat {
  comm: string;
  /** utime + stime in clock ticks. */
  ticks: number;
  threads: number;
  rssPages: number;
}

/** One /proc/<pid>/stat: the program name sits in parentheses (and may hold spaces), the numbers follow the last closing one. */
export function parseProcStat(text: string): ProcStat | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const number = (index: number) => Number(fields[index]);
  const values = [number(11), number(12), number(17), number(21)];
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  return {
    comm: text.slice(open + 1, close),
    ticks: (values[0] as number) + (values[1] as number),
    threads: values[2] as number,
    rssPages: values[3] as number,
  };
}

/** `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits`: how many processes hold GPU memory and the largest holding. */
export function parseComputeApps(text: string): { count: number; maxMb: number } {
  const used = text
    .split("\n")
    .map((line) => Number(line.split(",")[1]))
    .filter((value) => Number.isFinite(value));
  return { count: used.length, maxMb: used.length > 0 ? Math.max(...used) : 0 };
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

/** `nvidia-smi --query-gpu=utilization.gpu,memory.used`: the first GPU's use in percent and memory in MB. */
function parseGpuUsage(text: string): { util: number; memMb: number } | undefined {
  const [util, memMb] = text.trim().split("\n")[0]?.split(",").map(Number) ?? [];
  return Number.isFinite(util) && Number.isFinite(memMb) ? { util: util as number, memMb: memMb as number } : undefined;
}

export function parseGpuFacts(text: string): { name: string; memMb: number } | undefined {
  const [name, mem] =
    text
      .trim()
      .split("\n")[0]
      ?.split(",")
      .map((part) => part.trim()) ?? [];
  const memMb = Number(mem);
  return name && Number.isFinite(memMb) ? { name, memMb } : undefined;
}

/** `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`: one number per GPU, in MB. */
const parseGpuMemories = (text: string): number[] =>
  text
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

/** Memory in MB: from /proc/meminfo, else from the operating system API. */
function readMemory(host: Host): { totalMb: number; availableMb: number } {
  const info = host.readProc("meminfo");
  return info ? parseMeminfo(info) : { totalMb: Math.round(host.totalMemoryBytes() / 1048576), availableMb: Math.round(host.freeMemoryBytes() / 1048576) };
}

// ----- reading -----

const TICKS_PER_SECOND = 100;
const PAGE_BYTES = 4096;

export interface Scan {
  shells: number;
  run: { processes: number; python: number; threads: number; rssMb: number; ticks: Map<number, number> };
}

/** One pass over the processes: counts bash processes on the machine and sums the run's processes (working directory under `runRoot`). */
export function scanProcesses(host: Host, runRoot: string | undefined): Scan {
  const scan: Scan = { shells: 0, run: { processes: 0, python: 0, threads: 0, rssMb: 0, ticks: new Map() } };
  const prefix = runRoot === undefined ? undefined : runRoot.endsWith("/") ? runRoot : `${runRoot}/`;
  let rssPages = 0;
  for (const process of host.processes({ cwd: prefix !== undefined })) {
    const stat = parseProcStat(process.stat);
    if (!stat) continue;
    if (stat.comm === "bash") scan.shells += 1;
    if (prefix === undefined || process.cwd === undefined) continue;
    if (process.cwd !== prefix.slice(0, -1) && !process.cwd.startsWith(prefix)) continue;
    scan.run.processes += 1;
    if (stat.comm.startsWith("python")) scan.run.python += 1;
    scan.run.threads += stat.threads;
    rssPages += stat.rssPages;
    scan.run.ticks.set(process.pid, stat.ticks);
  }
  scan.run.rssMb = Math.round((rssPages * PAGE_BYTES) / 1048576);
  return scan;
}

export interface MachineReaderOptions {
  /** The operating system (default: this Linux machine). */
  host?: Host;
  /** The run directory: processes working under it are the run's own. Without it the run's fields are null. */
  runRoot?: string;
  /** Slots held and waiting right now, per kind; left out in a run without gates. */
  slots?: () => { cpu?: { inUse: number; waiting: number }; gpu?: { inUse: number; waiting: number } };
}

/** Reads the machine. Keeps the last CPU reading to compute the busy share; the first call returns null for it. */
export class MachineReader {
  private lastCpu: CpuTimes | undefined;
  private lastTicks: Map<number, number> | undefined;
  private lastTs: number | undefined;
  private readonly host: Host;
  private readonly runRoot: string | undefined;
  private readonly slots: MachineReaderOptions["slots"];

  constructor(options: MachineReaderOptions = {}) {
    this.host = options.host ?? new LinuxHost();
    this.slots = options.slots;
    this.runRoot = options.runRoot === undefined ? undefined : this.host.realPath(options.runRoot);
  }

  async read(now: number, run: { rung: number; agents: number }): Promise<MachineSample> {
    const host = this.host;
    const stat = host.readProc("stat");
    const cpu = stat ? parseCpuLine(stat.split("\n")[0] ?? "") : undefined;
    const before = this.lastCpu;
    this.lastCpu = cpu;
    const mem = readMemory(host);
    const [load1, load5, load15] = host.loadAverage();
    const pressureText = host.readProc("pressure/cpu");
    const pressure = pressureText ? parsePressure(pressureText) : undefined;
    const scan = host.hasProc() ? scanProcesses(host, this.runRoot) : undefined;
    const runCpu = scan && this.runRoot !== undefined ? this.runCpuSince(scan.run.ticks, now) : null;
    const slotCounts = this.slots?.();
    const [usageText, appsText] = await Promise.all([
      host.gpuQuery("--query-gpu=utilization.gpu,memory.used"),
      host.gpuQuery("--query-compute-apps=pid,used_memory"),
    ]);
    const gpu = usageText === undefined ? undefined : parseGpuUsage(usageText);
    const apps = appsText === undefined ? undefined : parseComputeApps(appsText);
    return {
      ts: now,
      cores: host.cpuCount(),
      load1,
      load5,
      load15,
      cpuBusy: cpu && before ? busyShare(before, cpu) : null,
      memUsedMb: mem.totalMb - mem.availableMb,
      memAvailableMb: mem.availableMb,
      memTotalMb: mem.totalMb,
      shells: scan?.shells ?? null,
      gpuUtilPercent: gpu?.util ?? null,
      gpuMemUsedMb: gpu?.memMb ?? null,
      cpuPressure10: pressure?.avg10 ?? null,
      cpuPressure60: pressure?.avg60 ?? null,
      procsRunning: stat ? parseProcsRunning(stat) : null,
      iowaitShare: cpu && before ? fieldShare(before, cpu, "iowait") : null,
      stealShare: cpu && before ? fieldShare(before, cpu, "steal") : null,
      runProcesses: scan && this.runRoot !== undefined ? scan.run.processes : null,
      runPythonProcesses: scan && this.runRoot !== undefined ? scan.run.python : null,
      runThreads: scan && this.runRoot !== undefined ? scan.run.threads : null,
      runRssMb: scan && this.runRoot !== undefined ? scan.run.rssMb : null,
      runCpuSeconds: runCpu?.seconds ?? null,
      runCpuCores: runCpu?.cores ?? null,
      gpuProcesses: apps?.count ?? null,
      gpuProcMaxMb: apps?.maxMb ?? null,
      slotsInUse: slotCounts?.cpu?.inUse ?? null,
      slotsWaiting: slotCounts?.cpu?.waiting ?? null,
      gpuSlotsInUse: slotCounts?.gpu?.inUse ?? null,
      gpuSlotsWaiting: slotCounts?.gpu?.waiting ?? null,
      rung: run.rung,
      agents: run.agents,
    };
  }

  /** CPU seconds the run's processes used since the last reading, counted per process (a new process counts from its start). */
  private runCpuSince(ticks: Map<number, number>, now: number): { seconds: number; cores: number | null } | null {
    const previous = this.lastTicks;
    const previousTs = this.lastTs;
    this.lastTicks = ticks;
    this.lastTs = now;
    if (!previous || previousTs === undefined) return null;
    let delta = 0;
    for (const [pid, value] of ticks) delta += Math.max(0, value - (previous.get(pid) ?? 0));
    const seconds = delta / TICKS_PER_SECOND;
    const wall = (now - previousTs) / 1000;
    return { seconds, cores: wall > 0 ? seconds / wall : null };
  }
}

/** What the machine offers now, for the recommendation printed before a run. */
export async function readMachineFacts(measureMs = 500, host: Host = new LinuxHost()): Promise<MachineFacts> {
  const mem = readMemory(host);
  const cores = host.cpuCount();
  const first = host.readProc("stat");
  const [gpuText] = await Promise.all([host.gpuQuery("--query-gpu=memory.total"), new Promise((resolve) => setTimeout(resolve, measureMs))]);
  const second = host.readProc("stat");
  const share = first && second ? busyShare(parseCpuLine(first.split("\n")[0] ?? ""), parseCpuLine(second.split("\n")[0] ?? "")) : null;
  return { cores, busyCores: (share ?? 0) * cores, freeMemMb: mem.availableMb, gpuMemMb: gpuText ? parseGpuMemories(gpuText) : [] };
}
