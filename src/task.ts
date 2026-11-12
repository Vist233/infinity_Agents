import type { ModelConfig } from "sakura-agent";
import { type TaskProfile, profileProblems } from "./capacity.ts";
import type { Evaluator } from "./evaluation.ts";
import { type ReviewOutputSettings, reviewOutputProblems } from "./review-snapshot.ts";

/** What every kind of task has. */
interface TaskBase {
  /** A short name, used in the report. */
  name: string;
  /** The highest number of agents alive at once (the top of the ladder). */
  agents: number;
  model: ModelConfig;
  /** Token budget; the run stops softly when it is reached. Default: none. */
  tokens?: number;
  /** Minutes of silence after which a running agent counts as stuck; default 10. */
  stuckMinutes?: number;
  /** Where runs are created; default `runs` in the current directory. */
  runsDir?: string;
  /** What one heavy command of an agent needs; the capacity hint and the limits on commands (docs/16) read it. */
  profile?: TaskProfile;
}

export interface MathTask extends TaskBase {
  mode: "math";
  /** The proposition to prove, as Lean source of a Prop. The task author writes it; formalising words comes later. */
  statement: string;
  /** Extra words for the agents. */
  prompt?: string;
  /** `first-success` stops the run at the first accepted proof; `until-stopped` keeps looking for more. */
  stop: "first-success" | "until-stopped";
  /** Lean processes at once; default: the number of CPU cores. */
  leanPool?: number;
  /** Confine Lean processes with the operating system sandbox where one exists (default false: a proof file then runs with the user's rights). */
  sandbox?: boolean;
}

export type Direction = "max" | "min";

/** Is score `a` better than `b` when the metric goes in this direction? */
export const better = (a: number, b: number, direction: Direction): boolean => (direction === "max" ? a > b : a < b);

/** Settings of the safety review in front of the agents' commands (docs/05 section 6). */
export interface ReviewSettings {
  /** The reviewing model; default: the agents' model. */
  model?: ModelConfig;
  /** Stop an agent after this many refusals in a row (default 8). */
  breakerConsecutive?: number;
  /** Extra lines for the reviewer's policy lists, on top of the defaults. */
  policy?: { environment?: string[]; allow?: string[]; soft_deny?: string[]; hard_deny?: string[] };
}

/** The branch review of docs/10: every few minutes a forked copy of each agent's conversation looks at the work and may give advice. */
export interface BranchReviewSettings {
  /** Minutes between the reviews of one agent (default 7). */
  everyMinutes?: number;
  /** The most turns a reviewer may use (default 6). */
  maxTurns?: number;
  /** The most reviews running at once (default 3). */
  maxConcurrent?: number;
  /** Extend the default snapshot or select a task-specific sort field. */
  output?: ReviewOutputSettings;
}

export interface CodeTask extends TaskBase {
  mode: "code";
  /** The problem, in words. */
  prompt: string;
  /** Name in every work directory -> path on this machine. Each is copied once, made read-only and linked into the work directories. */
  files?: Record<string, string>;
  /** Taken away from the disk while the agents run and put back at the end; the evaluator gets their private paths. Same filesystem as the runs directory. */
  hidden?: string[];
  /** Files the agents must neither read nor change: the evaluator's program and anything like it (the review refuses them). */
  protect?: string[];
  /** Scores a submit. Without it the agents' own claims rank (marked self-reported). */
  evaluate?: Evaluator;
  /** Which number ranks; required with `evaluate`. */
  metric?: { name: string; direction: Direction };
  /** The safety review is the boundary of an agent that has a shell: it must be given, or switched off with `false` (then the report says so). */
  review: ReviewSettings | false;
  branchReview?: BranchReviewSettings;
  /** `until-stopped` runs until the user stops, the budget ends or a quota ends; `targetScore` also ends the run when a score reaches it. */
  stop: "until-stopped" | { targetScore: number };
  /** Evaluations at once (default 2). */
  evalSlots?: number;
  /** The least minutes between two submits of one agent (default 0). */
  submitIntervalMinutes?: number;
  /** An evaluation that takes longer is stopped (default 10 minutes). */
  evalTimeoutMinutes?: number;
  /** No shell command of an agent runs longer than this; the shell tool stops its whole process group (default 120). Commands never go to the background. */
  commandTimeoutMinutes?: number;
}

export type TaskDefinition = MathTask | CodeTask;

export const MAX_AGENTS = 100;

/** The one place that checks a task. A task that gets past it can run. */
export function defineTask<T extends TaskDefinition>(task: T): T {
  const problems: string[] = [];
  if (task.name.trim() === "") problems.push("name must not be empty");
  if (!Number.isInteger(task.agents) || task.agents < 1 || task.agents > MAX_AGENTS) problems.push(`agents must be a whole number from 1 to ${MAX_AGENTS}`);
  if (task.tokens !== undefined && !(task.tokens > 0)) problems.push("tokens must be positive");
  if (task.stuckMinutes !== undefined && !(task.stuckMinutes > 0)) problems.push("stuckMinutes must be positive");
  if (task.profile) problems.push(...profileProblems(task.profile));
  if (task.mode === "math") checkMath(task, problems);
  else checkCode(task, problems);
  if (problems.length > 0) throw new Error(`Invalid task '${task.name}': ${problems.join("; ")}`);
  return task;
}

function checkMath(task: MathTask, problems: string[]): void {
  if (task.statement.trim() === "") problems.push("statement must not be empty");
  if (task.leanPool !== undefined && !(task.leanPool >= 1)) problems.push("leanPool must be at least 1");
}

function checkCode(task: CodeTask, problems: string[]): void {
  if (task.prompt.trim() === "") problems.push("prompt must not be empty");
  if (task.evaluate && !task.metric) problems.push("metric is required with evaluate");
  if (task.metric && !task.evaluate) problems.push("metric needs an evaluate function (without one, agents' claims rank)");
  if (task.metric && task.metric.name.trim() === "") problems.push("metric name must not be empty");
  if (typeof task.stop === "object" && !Number.isFinite(task.stop.targetScore)) problems.push("stop.targetScore must be a number");
  if (typeof task.stop === "object" && !task.metric) problems.push("stop.targetScore needs a metric");
  if (task.review === undefined) problems.push("review must be given: settings, or false to run without it");
  if (task.evalSlots !== undefined && !(task.evalSlots >= 1)) problems.push("evalSlots must be at least 1");
  if (task.submitIntervalMinutes !== undefined && !(task.submitIntervalMinutes >= 0)) problems.push("submitIntervalMinutes must not be negative");
  if (task.evalTimeoutMinutes !== undefined && !(task.evalTimeoutMinutes > 0)) problems.push("evalTimeoutMinutes must be positive");
  if (task.commandTimeoutMinutes !== undefined && !(task.commandTimeoutMinutes > 0)) problems.push("commandTimeoutMinutes must be positive");
  const branch = task.branchReview;
  if (branch?.everyMinutes !== undefined && !(branch.everyMinutes > 0)) problems.push("branchReview.everyMinutes must be positive");
  if (branch?.maxTurns !== undefined && !(branch.maxTurns >= 1)) problems.push("branchReview.maxTurns must be at least 1");
  if (branch?.maxConcurrent !== undefined && !(branch.maxConcurrent >= 1)) problems.push("branchReview.maxConcurrent must be at least 1");
  if (branch?.output) problems.push(...reviewOutputProblems(branch.output).map((problem) => `branchReview.output: ${problem}`));
  for (const name of Object.keys(task.files ?? {})) if (!/^[A-Za-z0-9._-]+$/.test(name)) problems.push(`files: '${name}' is not a plain name`);
}
