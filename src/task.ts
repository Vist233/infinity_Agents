import type { ModelConfig } from "sakura-agent";

export interface TaskDefinition {
  /** A short name, used in the report. */
  name: string;
  mode: "math";
  /** The proposition to prove, as Lean source of a Prop. The task author writes it; formalising words comes later. */
  statement: string;
  /** Extra words for the agents. */
  prompt?: string;
  /** The highest number of agents alive at once (the top of the ladder). */
  agents: number;
  model: ModelConfig;
  /** `first-success` stops the run at the first accepted proof; `until-stopped` keeps looking for more. */
  stop: "first-success" | "until-stopped";
  /** Token budget; the run stops softly when it is reached. Default: none. */
  tokens?: number;
  /** Lean processes at once; default: the number of CPU cores. */
  leanPool?: number;
  /** Minutes of silence after which a running agent counts as stuck; default 10. */
  stuckMinutes?: number;
  /** Confine Lean processes with the operating system sandbox where one exists (default false: a proof file then runs with the user's rights). */
  sandbox?: boolean;
  /** Where runs are created; default `runs` in the current directory. */
  runsDir?: string;
}

export const MAX_AGENTS = 100;

/** The one place that checks a task. A task that gets past it can run. */
export function defineTask(task: TaskDefinition): TaskDefinition {
  const problems: string[] = [];
  if (task.name.trim() === "") problems.push("name must not be empty");
  if (task.statement.trim() === "") problems.push("statement must not be empty");
  if (!Number.isInteger(task.agents) || task.agents < 1 || task.agents > MAX_AGENTS) problems.push(`agents must be a whole number from 1 to ${MAX_AGENTS}`);
  if (task.tokens !== undefined && !(task.tokens > 0)) problems.push("tokens must be positive");
  if (task.leanPool !== undefined && !(task.leanPool >= 1)) problems.push("leanPool must be at least 1");
  if (task.stuckMinutes !== undefined && !(task.stuckMinutes > 0)) problems.push("stuckMinutes must be positive");
  if (problems.length > 0) throw new Error(`Invalid task '${task.name}': ${problems.join("; ")}`);
  return task;
}
