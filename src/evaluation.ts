import { spawn } from "node:child_process";

/** What an evaluator says about one submit. `score` is the number that ranks (null when the run failed); `metrics` may hold more numbers. */
export interface EvalResult {
  status: "ok" | "error";
  score: number | null;
  metrics: Record<string, number>;
  /** Words for the agent. The evaluator author must not put hidden data in here: the agent reads it. */
  details: string;
}

/** What the user's evaluator may see. It runs in the orchestrator process or starts processes of its own, outside the agent's shell. */
export interface EvalContext {
  workDir: string;
  /** The commit of the work directory that this submit made. */
  commit: string | null;
  /** The shell command that produced the result, as the agent stated it. */
  command: string;
  /** Files the agent listed (paths relative to the work directory). */
  files: string[];
  /** Private paths of the hidden data, in the order of the task's `hidden` list. Nothing is moved while the evaluator reads them. */
  hidden: string[];
  signal: AbortSignal;
}

export type Evaluator = (context: EvalContext) => Promise<EvalResult>;

export interface CommandEvaluatorOptions {
  file: string;
  args?: string[];
  /** Default: the work directory of the submit. */
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment variables. PATH, HOME and LANG are passed on; no other variable of the orchestrator is (no key reaches the evaluator). */
  env?: Record<string, string>;
}

const MAX_CAPTURE = 20_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * An evaluator that is a program (a Python script, say). It is started with the work directory, the commit and the private paths of the hidden
 * data in the variables INFINITY_WORK_DIR, INFINITY_COMMIT and INFINITY_HIDDEN_0, INFINITY_HIDDEN_1, ..., and must print a JSON object
 * `{"score": 0.93, "metrics": {...}, "details": "..."}` as the last line of its standard output. Any other ending is an error result.
 */
export function commandEvaluator(options: CommandEvaluatorOptions): Evaluator {
  return (context) => runProgram(options, context);
}

function runProgram(options: CommandEvaluatorOptions, context: EvalContext): Promise<EvalResult> {
  const env: Record<string, string> = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    LANG: process.env.LANG ?? "C.UTF-8",
    INFINITY_WORK_DIR: context.workDir,
    INFINITY_COMMIT: context.commit ?? "",
    ...Object.fromEntries(context.hidden.map((path, index) => [`INFINITY_HIDDEN_${index}`, path])),
    ...options.env,
  };
  return new Promise<EvalResult>((resolve) => {
    const child = spawn(options.file, options.args ?? [], { cwd: options.cwd ?? context.workDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    let timedOut = false;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out = (out + chunk.toString("utf8")).slice(-MAX_CAPTURE);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString("utf8")).slice(-MAX_CAPTURE);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    context.signal.addEventListener("abort", killGroup, { once: true });
    const settle = (result: EvalResult) => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", killGroup);
      resolve(result);
    };
    child.on("error", (error) => settle(failure(`the evaluator could not be started: ${error.message}`)));
    child.on("close", (code) => {
      if (timedOut) return settle(failure(`the evaluator did not finish in time (${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s)`));
      if (context.signal.aborted) return settle(failure("the evaluation was cancelled"));
      if (code !== 0) return settle(failure(`the evaluator failed (exit ${code}): ${tail(err || out)}`));
      settle(parseResult(out));
    });
  });
}

const tail = (text: string): string => text.trim().split("\n").slice(-6).join("\n").slice(-800);

function failure(details: string): EvalResult {
  return { status: "error", score: null, metrics: {}, details };
}

/** The last non-empty line of the output must be the JSON object. */
export function parseResult(output: string): EvalResult {
  const line = output
    .trim()
    .split("\n")
    .findLast((candidate) => candidate.trim() !== "");
  try {
    const value = JSON.parse(line ?? "") as { score?: unknown; metrics?: unknown; details?: unknown };
    if (typeof value.score !== "number" || !Number.isFinite(value.score)) return failure("the evaluator's answer has no numeric 'score'");
    const metrics = Object.fromEntries(
      Object.entries((value.metrics ?? {}) as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
    return { status: "ok", score: value.score, metrics, details: typeof value.details === "string" ? value.details : "" };
  } catch {
    return failure(`the evaluator's last output line is not JSON: ${tail(output)}`);
  }
}
