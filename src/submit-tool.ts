import type { Tool, ToolResult } from "sakura-agent";
import type { CodeSubmission, ToolHelpers } from "./mode.ts";
import type { EvalResult } from "./evaluation.ts";
import { better } from "./task.ts";

export const MAX_ENTRY_CHARS_PER_FILE = 20_000;
const MAX_ENTRY_CHARS = 60_000;

export interface SubmitToolOptions {
  /** Scores a submit. Returns the score and metrics; or the agent's claim (self-reported) when the task has no evaluator. */
  evaluate: (input: {
    command: string;
    files: string[];
    commit: string | null;
    claim: Record<string, number>;
    signal: AbortSignal;
    workDir: string;
  }) => Promise<{ result: EvalResult; selfReported: boolean }>;
  /** Records the submit; called before the agent sees the answer. */
  onSubmit: (submission: CodeSubmission) => Promise<void>;
  helpers: ToolHelpers;
  metricName: string | undefined;
  direction: "max" | "min";
  /** Least time between two submits of this agent. */
  minIntervalMs: number;
  now: () => number;
}

const text = (message: string, isError = false): ToolResult => ({ content: [{ type: "text", text: message }], ...(isError ? { isError } : {}) });

/** The agent's one official way to have a result counted (docs/05 section 3.1). One tool per agent: it remembers that agent's last submit and best score. */
export function createSubmitTool(options: SubmitToolOptions): Tool {
  let lastSubmitAt: number | undefined;
  let best: number | undefined;
  return {
    name: "submit",
    description:
      "Sends a result to be counted and scored. Give the shell command that produced it (for example 'python train.py') and the files that hold the result " +
      "(for example predictions.csv). Your directory is committed first, so the result can always be traced to these files. The answer says how it scored.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command that produced the result." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Files (relative to your directory) that hold the result, such as predictions.csv or the script.",
        },
        claim: {
          type: "object",
          description: 'Only when the task has no scorer: your own numbers, for example {"accuracy": 0.9}.',
          additionalProperties: { type: "number" },
        },
        note: { type: "string", description: "A short remark for the record." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    effect: "exec",
    executionMode: "serial",
    async execute(args, context) {
      const input = parseArgs(args);
      if (typeof input === "string") return text(input, true);
      const waitMs = lastSubmitAt === undefined ? 0 : lastSubmitAt + options.minIntervalMs - options.now();
      if (waitMs > 0) return text(`You submitted a moment ago. Submit again in ${Math.ceil(waitMs / 1000)} seconds; use the time to improve the result.`, true);
      lastSubmitAt = options.now();
      const commit = await options.helpers.commitNow();
      const entry = await readEntry(input.files, context);
      const { result, selfReported } = await options.evaluate({
        command: input.command,
        files: input.files,
        commit,
        claim: input.claim,
        signal: context.signal,
        workDir: options.helpers.workDir,
      });
      await options.onSubmit({ kind: "code", command: input.command, files: input.files, entry, result, selfReported });
      if (!selfReported && result.status === "ok" && result.score !== null && (best === undefined || better(result.score, best, options.direction)))
        best = result.score;
      const answer = describe(result, selfReported, options.metricName);
      return text(best !== undefined && !selfReported && result.status === "ok" ? `${answer}\nYour best so far: ${best}.` : answer, result.status === "error");
    },
  };
}

interface Input {
  command: string;
  files: string[];
  claim: Record<string, number>;
}

function parseArgs(args: unknown): Input | string {
  const value = (args ?? {}) as { command?: unknown; files?: unknown; claim?: unknown };
  if (typeof value.command !== "string" || value.command.trim() === "") return "The 'command' that produced the result is required.";
  const files = Array.isArray(value.files) ? value.files.filter((file): file is string => typeof file === "string" && file !== "") : [];
  const claim = Object.fromEntries(
    Object.entries((value.claim ?? {}) as Record<string, unknown>).filter((pair): pair is [string, number] => typeof pair[1] === "number"),
  );
  return { command: value.command.trim(), files, claim };
}

async function readEntry(files: string[], context: { env: { readFile(path: string): Promise<Uint8Array> } }): Promise<string> {
  let total = 0;
  const parts: string[] = [];
  for (const file of files) {
    let body: string;
    try {
      body = new TextDecoder().decode(await context.env.readFile(file));
    } catch {
      parts.push(`=== ${file} (not readable) ===`);
      continue;
    }
    const room = Math.max(0, Math.min(MAX_ENTRY_CHARS_PER_FILE, MAX_ENTRY_CHARS - total));
    const cut = body.length > room;
    parts.push(`=== ${file}${cut ? ` (first ${room} of ${body.length} characters)` : ""} ===\n${body.slice(0, room)}`);
    total += Math.min(body.length, room);
  }
  return parts.join("\n");
}

function describe(result: EvalResult, selfReported: boolean, metricName: string | undefined): string {
  if (result.status === "error") return `The result could not be scored: ${result.details}`;
  const name = metricName ?? "score";
  const extras = Object.entries(result.metrics)
    .filter(([key]) => key !== name)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  const head = selfReported
    ? `Recorded as self-reported (${name} ${result.score ?? "none"}); nothing was verified.`
    : `Scored: ${name} ${result.score}${extras ? ` (${extras})` : ""}.`;
  return result.details ? `${head}\n${result.details}` : head;
}
