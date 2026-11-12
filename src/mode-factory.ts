import type { LlmClient, ModelConfig } from "sakura-agent";
import type { Clock } from "./clock.ts";
import { CodeMode } from "./code-mode.ts";
import { HiddenKeeper } from "./hidden-keeper.ts";
import { MathMode } from "./math-mode.ts";
import type { Mode } from "./mode.ts";
import { Pool } from "./pool.ts";
import type { ReportKind } from "./report.ts";
import type { SlotGate } from "./slot-gate.ts";
import type { RunLayout } from "./run-layout.ts";
import type { TaskDefinition } from "./task.ts";

export interface ModeContext {
  task: TaskDefinition;
  layout: RunLayout;
  clock: Clock;
  /** A client behind the Gate for the given model; without a model, the agents' own client. The safety review of code mode asks through it. */
  clientFor(model?: ModelConfig): LlmClient;
  /** The CPU slot gate of the run, when it has one (code mode only). */
  gate?: SlotGate;
}

const DEFAULT_EVAL_SLOTS = 2;

/** The one place that knows which kinds of task exist. */
export function createMode(context: ModeContext): Mode {
  const { task, layout } = context;
  if (task.mode === "math") return new MathMode({ task, leanDir: layout.leanDir });
  const keeper = task.hidden && task.hidden.length > 0 ? new HiddenKeeper({ dir: layout.keeperDir, now: () => context.clock.now() }) : undefined;
  return new CodeMode({
    task,
    layout,
    clock: context.clock,
    evalPool: new Pool(task.evalSlots ?? DEFAULT_EVAL_SLOTS),
    keeper,
    reviewClient: context.clientFor(task.review ? task.review.model : undefined),
    ...(context.gate ? { gate: context.gate } : {}),
  });
}

/** The kind of report a task gets. */
export function reportKindOf(task: TaskDefinition): ReportKind {
  return task.mode === "code" ? { mode: "code", metric: task.metric ?? { name: "claimed score", direction: "max" } } : { mode: "math" };
}

/** True when a resumed run has nothing left to do (a math run that stops at its first proof, and has one). */
export function isFinishedBefore(task: TaskDefinition, prior: { finished: string | null }): boolean {
  return prior.finished === "proved" && task.mode === "math" && task.stop === "first-success";
}
