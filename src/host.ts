import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { cpus, freemem, loadavg, release, totalmem } from "node:os";
import { join } from "node:path";

/**
 * The port to the operating system (docs/18): everything the machine readings, the cleanup of leftover processes and the platform check need from the machine,
 * as plain operations that return text or numbers. Nothing here parses: the readers turn the text into figures (`proc-readings.ts`), so they can be tested with
 * `FakeHost` on any system, and `LinuxHost` is tested against the real thing on Linux.
 */
export interface HostProcess {
  pid: number;
  /** The text of /proc/<pid>/stat. */
  stat: string;
  /** The working directory (the target of /proc/<pid>/cwd); undefined when it cannot be read. */
  cwd?: string;
}

export interface Host {
  /** The operating system name (`process.platform`). */
  readonly platform: string;
  /** Is there a /proc to read? */
  hasProc(): boolean;
  /** The text of /proc/<relative> ("stat", "meminfo", "pressure/cpu", "sys/kernel/osrelease"); undefined when it is not there. */
  readProc(relative: string): string | undefined;
  /** One pass over the processes: the numeric entries of /proc (at most `cap`, default 20,000), each with its stat text and, with `cwd`, its working directory. */
  processes(options?: { cap?: number; cwd?: boolean }): HostProcess[];
  /** Is the process there and not ended? A zombie counts as ended. */
  isAlive(pid: number): boolean;
  /** Sends a signal to one process id. Throws when it cannot (the process is gone, or is not ours). */
  signal(pid: number, signal: NodeJS.Signals): void;
  /** Sets the niceness of one process (renice); true when it worked. */
  setPriority(pid: number, nice: number): Promise<boolean>;
  cpuCount(): number;
  /** The 1, 5 and 15 minute load averages. */
  loadAverage(): [number, number, number];
  /** Memory as the operating system API reports it, in bytes (the fallback where /proc/meminfo is missing). */
  totalMemoryBytes(): number;
  freeMemoryBytes(): number;
  /** The kernel release string of the operating system API (the fallback where /proc/sys/kernel/osrelease is missing). */
  release(): string;
  /** The real path of a file or directory (links followed); the path itself when it cannot be resolved. */
  realPath(path: string): string;
  /** The output of `nvidia-smi <query> --format=csv,noheader,nounits`; undefined where there is no nvidia-smi or it fails. */
  gpuQuery(query: string): Promise<string | undefined>;
  /** Is this program on the PATH? */
  hasProgram(program: string): Promise<boolean>;
  /** The commit of the code in the current directory (`git rev-parse HEAD`); undefined without Git. */
  gitCommit(): Promise<string | undefined>;
}

const PROCESS_CAP = 20_000;

const run = (command: string, args: string[]): Promise<string | undefined> =>
  new Promise((resolve) => execFile(command, args, { timeout: 4000 }, (error, stdout) => resolve(error ? undefined : stdout)));

/** The host of a Linux machine. `procDir` is for tests that point it at a fake /proc tree. */
export class LinuxHost implements Host {
  readonly platform = process.platform;
  private readonly procDir: string;

  constructor(options: { procDir?: string } = {}) {
    this.procDir = options.procDir ?? "/proc";
  }

  hasProc(): boolean {
    return existsSync(join(this.procDir, "self"));
  }

  readProc(relative: string): string | undefined {
    const path = join(this.procDir, relative);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  processes(options: { cap?: number; cwd?: boolean } = {}): HostProcess[] {
    const found: HostProcess[] = [];
    let seen = 0;
    for (const entry of readdirSync(this.procDir)) {
      if (!/^\d+$/.test(entry)) continue;
      if (++seen > (options.cap ?? PROCESS_CAP)) break;
      try {
        const stat = readFileSync(join(this.procDir, entry, "stat"), "utf8");
        let cwd: string | undefined;
        if (options.cwd) {
          try {
            cwd = readlinkSync(join(this.procDir, entry, "cwd"));
          } catch {
            // ended meanwhile, or belongs to somebody whose directory cannot be read
          }
        }
        found.push({ pid: Number(entry), stat, ...(cwd === undefined ? {} : { cwd }) });
      } catch {
        // the process ended meanwhile
      }
    }
    return found;
  }

  isAlive(pid: number): boolean {
    try {
      return !readFileSync(join(this.procDir, String(pid), "stat"), "utf8").includes(") Z "); // a zombie has ended
    } catch {
      return false;
    }
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    process.kill(pid, signal);
  }

  setPriority(pid: number, nice: number): Promise<boolean> {
    return new Promise((resolve) => execFile("renice", ["-n", String(Math.floor(nice)), "-p", String(pid)], { timeout: 4000 }, (error) => resolve(!error)));
  }

  cpuCount(): number {
    return cpus().length;
  }

  loadAverage(): [number, number, number] {
    const [one, five, fifteen] = loadavg();
    return [one ?? 0, five ?? 0, fifteen ?? 0];
  }

  totalMemoryBytes(): number {
    return totalmem();
  }

  freeMemoryBytes(): number {
    return freemem();
  }

  release(): string {
    return release();
  }

  realPath(path: string): string {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }

  gpuQuery(query: string): Promise<string | undefined> {
    return run("nvidia-smi", [query, "--format=csv,noheader,nounits"]);
  }

  hasProgram(program: string): Promise<boolean> {
    return new Promise((resolve) => execFile("sh", ["-c", `command -v ${program}`], (error) => resolve(!error)));
  }

  gitCommit(): Promise<string | undefined> {
    return run("git", ["rev-parse", "HEAD"]);
  }
}

/** What a FakeHost is made of. Everything has a default that stands for a quiet Linux machine with nothing on it. */
export interface FakeHostState {
  platform?: string;
  /** Text of /proc files by relative path; `proc: false` stands for a machine without /proc. */
  files?: Record<string, string>;
  proc?: boolean;
  processes?: HostProcess[];
  cores?: number;
  load?: [number, number, number];
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  release?: string;
  /** Answers of nvidia-smi by query ("--query-gpu=memory.total"); a query that is not there fails. */
  gpu?: Record<string, string>;
  programs?: string[];
  commit?: string;
  /** Called when a signal arrives, so a test can end the process (call `host.end(pid)`). */
  onSignal?: ((pid: number, signal: NodeJS.Signals, host: FakeHost) => void) | undefined;
}

/** A host that lives in memory: the same operations, answered from a table, with a record of the signals and priorities it was given. */
export class FakeHost implements Host {
  readonly platform: string;
  readonly signals: Array<[number, NodeJS.Signals]> = [];
  readonly priorities: Array<[number, number]> = [];
  readonly state: Required<Omit<FakeHostState, "onSignal">> & Pick<FakeHostState, "onSignal">;

  constructor(state: FakeHostState = {}) {
    this.platform = state.platform ?? "linux";
    this.state = {
      platform: this.platform,
      files: state.files ?? {},
      proc: state.proc ?? true,
      processes: state.processes ?? [],
      cores: state.cores ?? 4,
      load: state.load ?? [0, 0, 0],
      totalMemoryBytes: state.totalMemoryBytes ?? 8 * 1024 ** 3,
      freeMemoryBytes: state.freeMemoryBytes ?? 4 * 1024 ** 3,
      release: state.release ?? "fake-release",
      gpu: state.gpu ?? {},
      programs: state.programs ?? [],
      commit: state.commit ?? "",
      onSignal: state.onSignal,
    };
  }

  /** The process ended (or was never there). */
  end(pid: number): void {
    this.state.processes = this.state.processes.filter((process) => process.pid !== pid);
  }

  hasProc(): boolean {
    return this.state.proc;
  }

  readProc(relative: string): string | undefined {
    return this.state.proc ? this.state.files[relative] : undefined;
  }

  processes(options: { cap?: number; cwd?: boolean } = {}): HostProcess[] {
    if (!this.state.proc) return [];
    return this.state.processes
      .slice(0, options.cap ?? PROCESS_CAP)
      .map(({ pid, stat, cwd }) => ({ pid, stat, ...(options.cwd && cwd !== undefined ? { cwd } : {}) }));
  }

  isAlive(pid: number): boolean {
    const found = this.state.processes.find((process) => process.pid === pid);
    return found !== undefined && !found.stat.includes(") Z ");
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    if (!this.state.processes.some((process) => process.pid === pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    this.signals.push([pid, signal]);
    this.state.onSignal?.(pid, signal, this);
  }

  async setPriority(pid: number, nice: number): Promise<boolean> {
    if (!this.state.processes.some((process) => process.pid === pid)) return false;
    this.priorities.push([pid, nice]);
    return true;
  }

  cpuCount(): number {
    return this.state.cores;
  }

  loadAverage(): [number, number, number] {
    return [...this.state.load];
  }

  totalMemoryBytes(): number {
    return this.state.totalMemoryBytes;
  }

  freeMemoryBytes(): number {
    return this.state.freeMemoryBytes;
  }

  release(): string {
    return this.state.release;
  }

  realPath(path: string): string {
    return path;
  }

  async gpuQuery(query: string): Promise<string | undefined> {
    return this.state.gpu[query];
  }

  async hasProgram(program: string): Promise<boolean> {
    return this.state.programs.includes(program);
  }

  async gitCommit(): Promise<string | undefined> {
    return this.state.commit === "" ? undefined : this.state.commit;
  }
}
