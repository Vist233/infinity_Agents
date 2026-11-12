import type { ModelConfig, Tool, ToolResult } from "sakura-agent";
import { type LaunchOptions, type RunHandle, type TaskPackage, readRunEvents, readRunStatus, startRun } from "./launch.ts";

/**
 * The same entry as `infinity run`, as tools of a Sakura agent: `infinity_run` starts a run in this process, `infinity_status` reads any run directory,
 * `infinity_stop` ends a run this tool started. Only the library API (launch.ts) is used. The agent chooses the task by name among `packs`, and may choose the
 * number of agents; without a number the machine's recommendation is used.
 */
export interface InfinityToolsOptions {
  /** The tasks the agent may start. */
  packs: readonly TaskPackage[];
  model: ModelConfig;
  /** Options for every run the tools start (for example `runsDir`, `createEnvironment`); the agent's own choices are laid over them. */
  defaults?: Partial<Omit<LaunchOptions, "model" | "resume" | "signal">>;
}

const text = (message: string, isError = false): ToolResult => ({ content: [{ type: "text", text: message }], ...(isError ? { isError } : {}) });
const inputOf = (raw: unknown): Record<string, unknown> => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {});
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export function createInfinityTools(options: InfinityToolsOptions): Tool[] {
  const handles = new Map<string, RunHandle>();
  let lastRun: string | undefined;
  const pick = (runDir: unknown): string | undefined => (typeof runDir === "string" && runDir !== "" ? runDir : lastRun);

  const run: Tool = {
    name: "infinity_run",
    description:
      "Starts a run of many agents on one task and returns at once; the run goes on in the background. Give the task name. The number of agents is yours to choose; " +
      "without it the machine's recommendation is used. Watch the run with infinity_status; end it with infinity_stop.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: `One of: ${options.packs.map((pack) => `${pack.name} (${pack.summary})`).join("; ")}` },
        agents: { type: "number", description: "Number of agents (always wins over the recommendation)." },
        tokens: { type: "number", description: "Token budget." },
        wallMinutes: { type: "number", description: "End the run in order after this many minutes." },
        review: { type: "boolean", description: "false leaves the branch review out (default true)." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    effect: "exec",
    executionMode: "serial",
    async execute(rawArgs) {
      const args = inputOf(rawArgs);
      const pack = options.packs.find((candidate) => candidate.name === args.task);
      if (!pack) return text(`Unknown task. Choose one of: ${options.packs.map((candidate) => candidate.name).join(", ")}`, true);
      const agents = asNumber(args.agents);
      const tokens = asNumber(args.tokens);
      const wallMinutes = asNumber(args.wallMinutes);
      try {
        const handle = await startRun(pack, {
          ...options.defaults,
          model: options.model,
          ...(agents === undefined ? {} : { agents }),
          ...(tokens === undefined ? {} : { tokens }),
          ...(wallMinutes === undefined ? {} : { wallMinutes }),
          ...(args.review === false ? { review: false as const } : {}),
        });
        handles.set(handle.runDir, handle);
        lastRun = handle.runDir;
        handle.done.catch(() => {}); // the outcome is read through infinity_status
        return text(`${handle.recommendation.lines.join("\n")}\nStarted with ${handle.agents} agents. Run directory: ${handle.runDir}`);
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  };

  const status: Tool = {
    name: "infinity_status",
    description:
      "Reads the state of a run from its files: running, stopped or finished, why, agents alive, tokens, best score, results, warnings and the newest events.",
    parameters: {
      type: "object",
      properties: {
        runDir: { type: "string", description: "The run directory (default: the run started last by infinity_run)." },
        recentEvents: { type: "number", description: "How many of the newest events to include (default 5)." },
      },
      additionalProperties: false,
    },
    effect: "read",
    executionMode: "parallel",
    async execute(rawArgs) {
      const args = inputOf(rawArgs);
      const runDir = pick(args.runDir);
      if (!runDir) return text("No run yet: start one with infinity_run, or give runDir.", true);
      const { events } = readRunEvents(runDir);
      const recent = events.slice(-Math.max(0, asNumber(args.recentEvents) ?? 5));
      return text(JSON.stringify({ ...readRunStatus(runDir), recentEvents: recent }, null, 2));
    },
  };

  const stop: Tool = {
    name: "infinity_stop",
    description: "Ends a run that infinity_run started, in order (agents stopped, report written), and waits for it. Returns why it ended and the best score.",
    parameters: {
      type: "object",
      properties: { runDir: { type: "string", description: "The run directory (default: the run started last)." } },
      additionalProperties: false,
    },
    effect: "exec",
    executionMode: "serial",
    async execute(rawArgs) {
      const args = inputOf(rawArgs);
      const runDir = pick(args.runDir);
      const handle = runDir ? handles.get(runDir) : undefined;
      if (!handle) return text("No such run started by this tool.", true);
      try {
        return text(JSON.stringify(await handle.stop()));
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
  return [run, status, stop];
}
