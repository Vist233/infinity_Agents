import { type Environment, createLocalEnvironment } from "sakura-agent";
import { type TaskProfile, cpuOf } from "./capacity.ts";
import { binDirOf } from "./run-layout.ts";

/** Limits that cost nothing, put in front of every command an agent runs (docs/16 section B). */
export interface CommandLimits {
  /** Threads a job may use: the value of OMP_NUM_THREADS and the other thread variables of numeric libraries. */
  threadsPerJob: number;
  /** The niceness of the command's shell on Linux (its children inherit it); default 10. 0 leaves the priority alone. */
  niceLevel?: number;
  /** A GPU task: no GPU is visible to a command (CUDA_VISIBLE_DEVICES=-1) and the `gpu` shim of the run is on the PATH. */
  gpu?: boolean;
}

const THREAD_VARIABLES = ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"] as const;
const DEFAULT_NICE = 10;

export const limitsOf = (profile?: TaskProfile): CommandLimits => ({
  threadsPerJob: cpuOf(profile).threadsPerJob,
  ...(profile?.kind === "gpu" ? { gpu: true } : {}),
});

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The text that goes in front of a command: the thread variables, and a lower priority for the shell (niceness set to the level before the command starts; its children inherit it).
 * For a GPU task also: no GPU visible, the run's `gpu` shim on the PATH, and the agent's number for the shim's log. `context` is the run directory and the agent.
 */
export function limitPrefix(limits: CommandLimits, context?: { root: string; agent: number }): string {
  const threads = Math.max(1, Math.floor(limits.threadsPerJob));
  const nice = limits.niceLevel ?? DEFAULT_NICE;
  const exports = [...THREAD_VARIABLES.map((name) => `${name}=${threads}`)];
  if (limits.gpu && context) exports.push("CUDA_VISIBLE_DEVICES=-1", `INFINITY_AGENT=${context.agent}`, `PATH=${quote(binDirOf(context.root))}:"$PATH"`);
  const line = `export ${exports.join(" ")}; `;
  return nice > 0 ? `${line}renice -n ${Math.floor(nice)} -p $$ >/dev/null 2>&1; ` : line;
}

/**
 * The same environment, with the limits in front of every command. Nothing in the framework changes: this is the `createEnvironment` option.
 * The agent's own script can still set a variable again; this is guidance that works for every program that reads the variables, not a lock.
 */
export function limitCommands(env: Environment, limits: CommandLimits, context?: { root: string; agent: number }): Environment {
  const prefix = limitPrefix(limits, context);
  const wrap = (command: string) => `${prefix}${command}`;
  return {
    ...env,
    exec: (command, options) => env.exec(wrap(command), options),
    spawn: (command, options) => env.spawn(wrap(command), options),
  };
}

/** The agent number and the run directory in a work directory of a run (`<run>/agents/NNN/work`); agent 0 when it cannot be told. */
export function runPlaceOf(workDir: string): { root: string; agent: number } {
  const found = /^(.*)\/agents\/(\d+)\/work/.exec(workDir);
  return { root: found?.[1] ?? workDir, agent: Number(found?.[2] ?? 0) };
}

/** The environment factory of a run with these limits; `base` makes the underlying environment (default: this machine). */
export function limitedEnvironment(
  limits: CommandLimits,
  base: (paths: { workDir: string; sharedDir: string }) => Environment = ({ workDir }) => createLocalEnvironment(workDir),
): (paths: { workDir: string; sharedDir: string }) => Environment {
  return (paths) => limitCommands(base(paths), limits, runPlaceOf(paths.workDir));
}
