import type { ComponentContext, RunComponent } from "./component.ts";
import { type Host, LinuxHost } from "./host.ts";
import { JsonlFile } from "./jsonl.ts";
import type { RunEvent } from "./records.ts";

export interface LeftoverOptions {
  /** Time between the polite stop and the hard one (default 5 s). */
  graceMs?: number;
  /** The operating system (default: this Linux machine). */
  host?: Host;
  /** For tests: replaces the host's signal. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** For tests: replaces the real wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Process ids whose working directory is the run directory or below it, found through /proc/<pid>/cwd (never by name). */
export function processesUnder(root: string, host: Host = new LinuxHost()): number[] {
  if (!host.hasProc()) return [];
  const base = host.realPath(root);
  return host
    .processes({ cwd: true })
    .filter((process) => process.cwd !== undefined && (process.cwd === base || process.cwd.startsWith(`${base}/`)))
    .map((process) => process.pid);
}

/**
 * At the end of the run, stops every process that still has the run directory as its working directory: agents' background jobs and anything they left behind.
 * By process id, SIGTERM first and SIGKILL after a few seconds; never by name, never its own process. The count goes to the events and the report.
 * Where there is no /proc (macOS) it finds nothing.
 */
export function leftoverStopper(options: LeftoverOptions = {}): RunComponent {
  const host = options.host ?? new LinuxHost();
  const kill = options.kill ?? ((pid, signal) => host.signal(pid, signal));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = options.graceMs ?? 5000;
  let context: ComponentContext | undefined;
  let done = false;
  const send = (pid: number, signal: NodeJS.Signals) => {
    try {
      kill(pid, signal);
    } catch {
      // gone already, or not ours
    }
  };
  return {
    name: "leftover-stopper",
    start(started) {
      context = started;
    },
    async stop() {
      if (done || !context) return;
      done = true;
      const found = processesUnder(context.layout.root, host).filter((pid) => pid !== process.pid);
      if (!host.hasProc()) return;
      for (const pid of found) send(pid, "SIGTERM");
      let remaining = found;
      const step = Math.max(1, Math.min(200, graceMs));
      for (let waited = 0; remaining.length > 0 && waited < graceMs; waited += step) {
        await sleep(step);
        remaining = remaining.filter((pid) => host.isAlive(pid));
      }
      for (const pid of remaining) send(pid, "SIGKILL");
      const event: RunEvent = { type: "leftover_processes", ts: context.clock.now(), found: found.length, killedHard: remaining.length };
      new JsonlFile<RunEvent>(context.layout.events).append(event);
    },
  };
}
