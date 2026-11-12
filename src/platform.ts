import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The run side of Infinity Agent supports Linux only (docs/16): it reads /proc, uses renice, flock, process groups and nvidia-smi. Where a part is missing the
 * run does not pretend: this lists what is missing, as lines "unsupported on this OS: <feature>", for run-facts.json, the events and the preflight.
 */
export interface PlatformNeeds {
  /** The run has GPU slots: needs flock for the `gpu` shim and nvidia-smi for the GPUs. */
  gpu?: boolean;
  /** For tests: replaces the platform name, the /proc check and the program lookup. */
  platform?: string;
  hasProc?: boolean;
  has?: (program: string) => Promise<boolean>;
}

const hasProgram = (program: string): Promise<boolean> => new Promise((resolve) => execFile("sh", ["-c", `command -v ${program}`], (error) => resolve(!error)));

export async function unsupportedFeatures(needs: PlatformNeeds = {}): Promise<string[]> {
  const platform = needs.platform ?? process.platform;
  const has = needs.has ?? hasProgram;
  const missing: string[] = [];
  if (platform !== "linux")
    missing.push(`the operating system is ${platform}, not Linux (the machine readings, the limits on commands and the cleanup of processes need Linux)`);
  if (!(needs.hasProc ?? existsSync("/proc/self/stat"))) missing.push("/proc (machine readings, the run's own processes, the cleanup of leftover processes)");
  if (!(await has("renice"))) missing.push("renice (lower priority of the agents' commands)");
  if (needs.gpu) {
    if (!(await has("flock"))) missing.push("flock (the GPU slots: the `gpu` shim needs it, so GPU tasks are disabled)");
    if (!(await has("nvidia-smi"))) missing.push("nvidia-smi (the GPUs of a GPU task)");
  }
  return missing.map((feature) => `unsupported on this OS: ${feature}`);
}
