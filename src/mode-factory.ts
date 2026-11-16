import type { LlmClient, ModelConfig } from "sakura-agent";
import type { Clock } from "./clock.ts";
import { HiddenKeeper } from "./hidden-keeper.ts";
import type { LeanRunner } from "./lean-runner.ts";
import { leanKit } from "./lean-kit.ts";
import type { Kit, Mode } from "./mode.ts";
import { Pool } from "./pool.ts";
import type { Metric } from "./report.ts";
import { shellKit } from "./shell-kit.ts";
import type { SlotGate } from "./slot-gate.ts";
import type { RunLayout } from "./run-layout.ts";
import { TaskMode } from "./task-mode.ts";
import { PROOF_METRIC, type TaskDefinition, targetOf } from "./task.ts";
import type { Verifier } from "./verifier.ts";

export interface ModeContext {
  task: TaskDefinition;
  layout: RunLayout;
  clock: Clock;
  signal?: AbortSignal;
  /** A client behind the Gate for the given model; without a model, the agents' own client. The safety review asks through it. */
  clientFor(model?: ModelConfig): LlmClient;
  /** The CPU slot gate of the run, when it has one (the shell only). */
  gate?: SlotGate;
}

const DEFAULT_EVAL_SLOTS = 2;

/** For tests: a fake prover or a ready verifier for a proof task. */
export interface LeanTestParts {
  leanRunner?: LeanRunner;
  verifier?: Verifier;
}

/** The one place that knows which tools a task can have: it picks the kit and builds the mode around it. */
export function createMode(context: ModeContext, test: LeanTestParts = {}): Mode {
  const { task, layout } = context;
  const tools = task.tools ?? { kind: "shell" };
  const keeper = task.hidden && task.hidden.length > 0 ? new HiddenKeeper({ dir: layout.keeperDir, now: () => context.clock.now() }) : undefined;
  const kit: Kit =
    tools.kind === "lean"
      ? leanKit({ tools, prompt: task.prompt, leanDir: layout.leanDir, ...test })
      : shellKit({ task, layout, clock: context.clock, reviewClient: context.clientFor(task.review ? task.review.model : undefined), gate: context.gate });
  return new TaskMode({ task, layout, clock: context.clock, kit, evalPool: new Pool(task.evalSlots ?? DEFAULT_EVAL_SLOTS), keeper, signal: context.signal });
}

/** Which number ranks in the report: the task's metric, the proof metric of a proof task, or the agents' claims. */
export function metricOf(task: TaskDefinition): Metric {
  return task.metric ?? (task.tools?.kind === "lean" ? PROOF_METRIC : { name: "claimed score", direction: "max" });
}

/** True when a resumed run has nothing left to do: it ended on its target. */
export function isFinishedBefore(task: TaskDefinition, prior: { finished: string | null }): boolean {
  return prior.finished === "target" && targetOf(task) !== undefined;
}
