import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LEAN_INSTALL_COMMAND = "curl https://elan.lean-lang.org/elan-init.sh -sSf | sh";

export interface LeanInstall {
  /** The real `lean` executable of the active toolchain. */
  leanBin: string;
  leanVersion: string;
  lakeVersion: string;
}

async function output(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout: 120_000 });
  return stdout.trim();
}

/**
 * Start-up check of math mode: `lean --version` and `lake --version` must work. Stops with the install command when they do not.
 * Mathlib is not checked here; only a task that asks for it needs it.
 */
export async function findLean(): Promise<LeanInstall> {
  try {
    const leanVersion = await output("lean", ["--version"]);
    const lakeVersion = await output("lake", ["--version"]);
    const leanBin = await output("elan", ["which", "lean"]);
    return { leanBin, leanVersion, lakeVersion };
  } catch (error) {
    throw new Error(
      `Math mode needs a local Lean 4 (lean and lake on the PATH, installed with elan). Install it with:\n  ${LEAN_INSTALL_COMMAND}\n(${String(error)})`,
    );
  }
}
