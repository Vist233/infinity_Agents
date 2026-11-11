import { existsSync, statSync } from "node:fs";
import { type Agent, type Environment, type Event, type LlmClient, type Plugin, type Tool, corePlugins, createAgent } from "sakura-agent";
import type { Clock } from "./clock.ts";
import { commitPlugin } from "./commit-plugin.ts";
import type { Gate } from "./gate.ts";
import { type AgentEnd, type CancelReason, afterRun } from "./worker-policy.ts";
import type { AgentSetup, Submission } from "./mode.ts";
import type { ReviewTarget } from "./review-run.ts";
import type { RunLayout } from "./run-layout.ts";
import { commitAll, createWorkDir, headCommit } from "./work-repo.ts";

/** Creates an independent tool environment for a worker or its forked reviewer. */
export type WorkerEnvironmentFactory = (paths: { workDir: string; sharedDir: string }) => Environment;

/** What the orchestrator wants to hear from a worker. */
export interface WorkerHooks {
  /** Any event of the agent: a sign of life. */
  onActivity(): void;
  /** The agent finished a model reply. */
  onReply(): void;
  onCommit(commit: string, turn: number): void;
  /** The safety review refused an action. */
  onDenied(denial: { tool: string; decidedBy: string; reason: string }): void;
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
  createEnvironment?: WorkerEnvironmentFactory;
  /** Continue the agent's session file instead of starting with the prompt. */
  resume: boolean;
  clock: Clock;
  gate: Gate;
  hooks: WorkerHooks;
  /** How long to wait before an agent whose run was paused (a throttle that ran out of retries) goes on. */
  pauseRetryMs: number;
}

export type { AgentEnd, CancelReason };

export interface AgentWorker {
  readonly number: number;
  readonly done: Promise<AgentEnd>;
  cancel(reason: CancelReason): void;
  /** Cancels the current run and starts again with the message. */
  rescue(message: string): void;
  /** True while the agent is legitimately silent: waiting for the Gate, running a tool, or watching a background process. */
  excused(): boolean;
  /** What the branch review needs; undefined until the agent exists. */
  reviewTarget(): (ReviewTarget & { workDir: string }) | undefined;
}

/** Advice for an agent: handed to the active run at once, or kept until the next run starts (a run that is not active drops what is steered into it). */
export class AdviceBox {
  private readonly waiting: string[] = [];
  private run: { steer(text: string): void } | undefined;

  deliver(text: string): void {
    if (this.run) this.run.steer(text);
    else this.waiting.push(text);
  }

  attach(run: { steer(text: string): void }): void {
    this.run = run;
    for (const text of this.waiting.splice(0)) run.steer(text);
  }

  detach(): void {
    this.run = undefined;
  }
}

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
  let replies = 0;
  const advice = new AdviceBox();
  let configure: ((sessionFile: string, plugins: Plugin[], client: LlmClient) => Promise<Agent>) | undefined;

  const noteReview = (data: unknown) => {
    const review = data as { kind?: string; outcome?: string; tool?: string; decidedBy?: string; reason?: string };
    if (review.kind === "review" && review.outcome === "deny")
      hooks.onDenied({ tool: review.tool ?? "?", decidedBy: review.decidedBy ?? "?", reason: String(review.reason ?? "").slice(0, 300) });
  };

  const watch = async (events: AsyncIterable<Event>) => {
    for await (const event of events) {
      hooks.onActivity();
      if (event.type === "tool_start") inTool = true;
      if (event.type === "tool_end") inTool = false;
      if (event.type === "plugin" && event.name === "review") noteReview(event.data);
      if (event.type === "message_end" && event.message.role === "assistant") {
        pausesWithoutReply = 0;
        replies += 1;
        hooks.onReply();
      }
    }
  };

  const drive = async (): Promise<AgentEnd> => {
    const commits = commitPlugin({ dir: workDir, onCommit: hooks.onCommit });
    try {
      await createWorkDir(workDir, deps.setup);
      const commitNow = async (): Promise<string | null> => {
        await commits.flush();
        return (await commitAll(workDir, "submit")) ?? (await headCommit(workDir)) ?? null;
      };
      const submit = async (submission: Submission) => {
        const commit = await commitNow();
        const steps = agent ? (await agent.usage()).turns : 0;
        await hooks.onSubmit(submission, { commit, steps, elapsedMs: deps.clock.now() - startedAt });
      };
      // one function builds the agent and, for a branch review, its reviewer: the request prefix (system text, tools, messages) must be identical for the cache
      const build = (sessionFile: string, plugins: Plugin[], client: LlmClient, tools: Tool[]) =>
        createAgent({
          model: client,
          cwd: workDir,
          ...(deps.createEnvironment ? { environment: deps.createEnvironment({ workDir, sharedDir: layout.sharedDir }) } : { confine: deps.setup.confine }),
          tools: [...deps.setup.builtinTools, ...tools],
          plugins,
          rules: deps.setup.rules,
          sessionFile,
          goal: deps.setup.goal,
        });
      configure = (sessionFile, plugins, client) =>
        build(
          sessionFile,
          plugins,
          client,
          deps.setup.tools(async () => undefined, { commitNow: async () => null, workDir }),
        );
      agent = await build(
        layout.sessionFile(number),
        [...corePlugins(), commits, ...(deps.setup.plugins ?? [])],
        deps.client,
        deps.setup.tools(submit, { commitNow, workDir }),
      );
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
      advice.attach(run);
      const watching = watch(run.events);
      const result = await run.result;
      advice.detach();
      await watching;
      inTool = false;
      const next = afterRun({ cancelled: cancelReason, run: result, gateStopped: Boolean(deps.gate.stopped), pausesWithoutReply });
      if (next.type === "end") return next.end;
      if (next.type === "rescue") {
        cancelReason = undefined;
        input = rescueMessage;
        continue;
      }
      pausesWithoutReply += 1;
      input = undefined;
      await deps.clock.sleep(deps.pauseRetryMs);
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
    reviewTarget: () => {
      const live = agent;
      const build = configure;
      if (!live || !build) return undefined;
      return {
        workDir,
        replies: () => replies,
        fork: (path) => live.fork(path),
        // the reviewer has the same plugins as the agent, except the commit plugin (it must not write to the work directory) and the safety review (its guard is stricter)
        openReviewer: (sessionFile, guard, wrapClient) => build(sessionFile, [...corePlugins(), guard], wrapClient(deps.client)),
        advise: (text) => advice.deliver(text),
      };
    },
    excused: () => agent === undefined || inTool || deps.gate.paused || agent.pending().watching.length > 0,
  };
}

function hasSession(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}
