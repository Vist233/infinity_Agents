import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { Pool } from "./pool.ts";

export interface LeanRunRequest {
  cwd: string;
  args: string[];
  /** Directories searched for `.olean` files (becomes LEAN_PATH). */
  leanPath: string[];
  /** The only directories the process may write to. */
  writableDirs: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LeanRunResult {
  exitCode: number | null;
  /** stdout and stderr together, cut to the last MAX_OUTPUT characters. */
  output: string;
  timedOut: boolean;
}

/** Runs the `lean` executable. The verifier and the tool only know this interface, so tests can replace it with a fake prover. */
export interface LeanRunner {
  run(request: LeanRunRequest): Promise<LeanRunResult>;
  /** Whether processes are confined (no writes outside `writableDirs`, no network, no reading of the home directory). */
  readonly sandboxed: boolean;
}

const MAX_OUTPUT = 20_000;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface LeanRunnerOptions {
  /** Path of the real `lean` executable (not the elan proxy, which asks the network for updates). */
  leanBin: string;
  pool: Pool;
  /** Confine the processes with the macOS sandbox when it exists. Default false: the owner decided against it (docs/decisions.md, 28). */
  sandbox?: boolean;
}

/**
 * Lean files can run any code at compile time (`#eval`, macros), so a proof file is untrusted code.
 * The environment is always cleaned: no keys reach the process. Without the sandbox (the default) the process runs with the user's rights.
 * With `sandbox: true`, on macOS, the run is confined with the same mechanism Codex CLI uses (`sandbox-exec`): writes only to the given directories,
 * no network, no reading of the user's home directory except the Lean toolchain and the given directories.
 */
export function createLeanRunner(options: LeanRunnerOptions): LeanRunner {
  const sandboxed = (options.sandbox ?? false) && process.platform === "darwin" && existsSync(SANDBOX_EXEC);
  const toolchainRoot = real(dirname(dirname(options.leanBin)));

  return {
    sandboxed,
    run: (request) => options.pool.run(() => runProcess(options.leanBin, toolchainRoot, sandboxed, request), request.signal),
  };
}

function runProcess(leanBin: string, toolchainRoot: string, sandboxed: boolean, request: LeanRunRequest): Promise<LeanRunResult> {
  const command = sandboxed ? SANDBOX_EXEC : leanBin;
  const args = sandboxed ? ["-p", sandboxProfile(toolchainRoot, request), leanBin, ...request.args] : request.args;
  const env = { PATH: "/usr/bin:/bin", HOME: request.cwd, LEAN_PATH: request.leanPath.join(":") };

  return new Promise<LeanRunResult>((resolve, reject) => {
    if (request.signal?.aborted) return reject(request.signal.reason);
    const child = spawn(command, args, { cwd: request.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = () => killProcessGroup(child.pid);
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, request.timeoutMs);
    const onAbort = killGroup;
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      finish();
      reject(error);
    });
    child.on("close", (exitCode) => {
      finish();
      if (request.signal?.aborted) return reject(request.signal.reason);
      resolve({ exitCode, output, timedOut });
    });
  });
}

/** Kills the process and everything it started (a shell script, the sandbox wrapper), so that no one keeps the output open. */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

const real = (path: string): string => realpathSync(path);

function sandboxProfile(toolchainRoot: string, request: LeanRunRequest): string {
  const writable = request.writableDirs.map(real);
  const readable = [toolchainRoot, real(request.cwd), ...request.leanPath.map(real), ...writable];
  const quoted = (path: string) => `(subpath ${JSON.stringify(path)})`;
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map(quoted).join(" ")} (literal "/dev/null"))`,
    `(deny file-read-data ${quoted(real(homedir()))})`,
    `(allow file-read-data ${readable.map(quoted).join(" ")})`,
    "(deny network*)",
  ].join("\n");
}
