import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Agent, type Event, type LlmClient, type RunEndReason, corePlugins, createAgent } from "sakura-agent";
import type { Clock } from "./clock.ts";
import { commitPlugin } from "./commit-plugin.ts";
import type { Gate } from "./gate.ts";
import type { AgentSetup, Submission } from "./mode.ts";
import type { RunLayout } from "./run-layout.ts";
import { commitAll, headCommit, initWorkRepo } from "./work-repo.ts";

export type CancelReason = "retire" | "finish" | "stuck" | "rescue";

/** What the orchestrator wants to hear from a worker. */
export interface WorkerHooks {
  /** Any event of the agent: a sign of life. */
  onActivity(): void;
  /** The agent finished a model reply. */
  onReply(): void;
  onCommit(commit: string, turn: number): void;
  /** Called for every official submit before the agent is told the answer. */
  onSubmit(submission: Submission, info: { commit: string | null; steps: number; elapsedMs: number }): Promise<void>;
}

export interface WorkerDeps {
  number: number;
  layout: RunLayout;
  /** Already behind the Gate. */
  client: LlmClient;
  /** What the mode says about this agent: prompt, rules, goal, files, tools. */
  setup: AgentSetup;
  /** Continue the agent's session file instead of starting with the prompt. */
  resume: boolean;
  clock: Clock;
  gate: Gate;
  hooks: WorkerHooks;
  /** How long to wait before an agent whose run was paused (a throttle that ran out of retries) goes on. */
  pauseRetryMs: number;
}

export interface AgentEnd {
  reason: RunEndReason | "failed";
  cancelled?: CancelReason;
  detail?: string;
}

export interface AgentWorker {
  readonly number: number;
  readonly done: Promise<AgentEnd>;
  cancel(reason: CancelReason): void;
  /** Cancels the current run and starts again with the message. */
  rescue(message: string): void;
  /** True while the agent is legitimately silent: waiting for the Gate, running a tool, or watching a background process. */
  excused(): boolean;
}

const MAX_PAUSES_WITHOUT_REPLY = 20;

/** Starts one agent: its work directory (a Git repository), its session, its tools, and the loop that keeps it running until it ends. */
export function startWorker(deps: WorkerDeps): AgentWorker {
  const { layout, number, hooks } = deps;
  const workDir = layout.workDir(number);
  const startedAt = deps.clock.now();
  let agent: Agent | undefined;
  let cancelReason: CancelReason | undefined;
  let rescueMessage: string | undefined;
  let inTool = false;
  let pausesWithoutReply = 0;

  const watch = async (events: AsyncIterable<Event>) => {
    for await (const event of events) {
      hooks.onActivity();
      if (event.type === "tool_start") inTool = true;
      if (event.type === "tool_end") inTool = false;
      if (event.type === "message_end" && event.message.role === "assistant") {
        pausesWithoutReply = 0;
        hooks.onReply();
      }
    }
  };

  const drive = async (): Promise<AgentEnd> => {
    const commits = commitPlugin({ dir: workDir, onCommit: hooks.onCommit });
    try {
      await initWorkDir(layout, number, deps.setup.files);
      const submit = async (submission: Submission) => {
        await commits.flush();
        const commit = (await commitAll(workDir, "submit")) ?? (await headCommit(workDir)) ?? null;
        const steps = agent ? (await agent.usage()).turns : 0;
        await hooks.onSubmit(submission, { commit, steps, elapsedMs: deps.clock.now() - startedAt });
      };
      agent = await createAgent({
        model: deps.client,
        cwd: workDir,
        confine: deps.setup.confine,
        tools: [...deps.setup.builtinTools, ...deps.setup.tools(submit)],
        plugins: [...corePlugins(), commits],
        rules: deps.setup.rules,
        sessionFile: layout.sessionFile(number),
        goal: deps.setup.goal,
      });
      return await runUntilEnd(agent);
    } catch (error) {
      return { reason: "failed", detail: String(error) };
    } finally {
      await agent?.close().catch(() => {});
      await commits.flush();
    }
  };

  const runUntilEnd = async (live: Agent): Promise<AgentEnd> => {
    let input: string | undefined = deps.resume && hasSession(layout.sessionFile(number)) ? undefined : deps.setup.prompt;
    for (;;) {
      if (cancelReason && cancelReason !== "rescue") return { reason: "cancelled", cancelled: cancelReason };
      const run = live.run(input);
      const watching = watch(run.events);
      const result = await run.result;
      await watching;
      inTool = false;
      if (cancelReason === "rescue") {
        cancelReason = undefined;
        input = rescueMessage;
        continue;
      }
      if (cancelReason) return { reason: "cancelled", cancelled: cancelReason };
      if (result.reason === "paused" && !deps.gate.stopped && pausesWithoutReply < MAX_PAUSES_WITHOUT_REPLY) {
        pausesWithoutReply += 1;
        input = undefined;
        await deps.clock.sleep(deps.pauseRetryMs);
        continue;
      }
      return { reason: result.reason, ...(result.error ? { detail: result.error } : {}) };
    }
  };

  const done = drive();

  return {
    number,
    done,
    cancel(reason) {
      cancelReason = reason;
      agent?.cancel();
    },
    rescue(message) {
      cancelReason = "rescue";
      rescueMessage = message;
      agent?.cancel();
    },
    excused: () => agent === undefined || inTool || deps.gate.paused || agent.pending().watching.length > 0,
  };
}

function hasSession(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

/** Creates the work directory as a Git repository holding read-only copies of the given files. Safe to repeat on resume. */
async function initWorkDir(layout: RunLayout, number: number, files: Record<string, string>): Promise<void> {
  const workDir = layout.workDir(number);
  mkdirSync(workDir, { recursive: true });
  if (existsSync(join(workDir, ".git"))) return;
  for (const [name, content] of Object.entries(files)) {
    const path = join(workDir, name);
    writeFileSync(path, content);
    chmodSync(path, 0o444);
  }
  await initWorkRepo(workDir);
  await commitAll(workDir, "start");
}
