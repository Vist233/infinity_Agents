import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Clock } from "./clock.ts";
import type { EvalResult } from "./evaluation.ts";
import { type HiddenKeeper, type ProcessGuard, restoreOnExit } from "./hidden-keeper.ts";
import type { AgentSetup, Kit, Mode, Progress, ScoreInput, Submission, SubmitEffect, SubmitEnv, SubmitInfo } from "./mode.ts";
import type { Pool } from "./pool.ts";
import type { RunLayout } from "./run-layout.ts";
import { type TaskDefinition, better, targetOf } from "./task.ts";

const DEFAULT_EVAL_TIMEOUT_MINUTES = 10;

export interface TaskModeOptions {
  task: TaskDefinition;
  layout: RunLayout;
  clock: Clock;
  /** The tools of the agents and what goes with them (a shell and `submit`, or the `lean` tool). */
  kit: Kit;
  /** Evaluations wait here (one place per running evaluation). */
  evalPool: Pool;
  /** Present when the task has hidden data; the mode hides it in `prepare` and puts it back in `finish`. */
  keeper?: HiddenKeeper | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * The one mode: agents improve a result, and every official submit is scored (by the task's evaluator, or by the Lean verifier of a proof task). The mode owns what
 * is the same for every task: the shared files, the hidden data, the ledger line of a submit, the best score, the target, the end markers. The tools are the kit's.
 */
export class TaskMode implements Mode {
  readonly plannerKind: "math" | "code";
  readonly plannerSubject: string;
  readonly branchReview: TaskDefinition["branchReview"];
  private bestScore: number | null = null;
  private readonly options: TaskModeOptions;
  private readonly sharedLinks: Record<string, string> = Object.create(null);
  private hiddenPaths: string[] = [];
  private prepared = false;
  private guard: ProcessGuard | undefined;

  constructor(options: TaskModeOptions) {
    this.options = options;
    this.plannerKind = options.kit.plannerKind;
    this.plannerSubject = options.kit.plannerSubject;
    this.branchReview = options.task.branchReview;
  }

  restore(prior: Progress): void {
    this.bestScore = prior.bestScore;
  }

  /** Writes the result down; keeps the best verified score; ends the run when the target is reached. */
  accept(agent: number, submission: Submission, info: SubmitInfo, env: SubmitEnv): SubmitEffect {
    const { result } = submission;
    env.recorder.result(agent, {
      command: submission.command,
      entry: submission.entry,
      files: submission.files,
      status: result.status,
      score: result.score,
      metrics: result.metrics,
      details: result.details,
      selfReported: submission.selfReported,
      ...info,
    });
    if (result.status !== "ok" || result.score === null || submission.selfReported) return { changed: false };
    const { task } = this.options;
    const direction = task.metric?.direction ?? "max";
    if (this.bestScore === null || better(result.score, this.bestScore, direction)) this.bestScore = result.score;
    const target = targetOf(task);
    if (target !== undefined && (direction === "max" ? result.score >= target : result.score <= target)) {
      env.recorder.event({ type: "target", agent, score: result.score });
      return { changed: true, finish: "target" };
    }
    return { changed: true };
  }

  progress(): Progress {
    return { bestScore: this.bestScore };
  }

  endFields(): { bestScore?: number | null } {
    return { bestScore: this.bestScore };
  }

  async prepare(): Promise<void> {
    const { task, layout, keeper } = this.options;
    const originals = (task.hidden ?? []).map((path) => resolve(path));
    const hiddenSources = originals.map((path) => (existsSync(path) ? realpathSync(path) : path));
    const files = Object.entries(task.files ?? {}).map(([name, source]) => {
      const from = resolve(source);
      if (!existsSync(from)) throw new Error(`files['${name}']: ${from} does not exist`);
      const visible = realpathSync(from);
      if (hiddenSources.some((hidden) => containsPath(visible, hidden) || containsPath(hidden, visible))) {
        throw new Error(`files['${name}'] overlaps hidden data. Use separate paths for visible and hidden files.`);
      }
      return { name, from };
    });
    for (const { name, from } of files) {
      const to = join(layout.sharedDir, name);
      if (!existsSync(to)) {
        mkdirSync(layout.sharedDir, { recursive: true });
        const staging = mkdtempSync(join(layout.root, ".shared-"));
        try {
          const copy = join(staging, name);
          cpSync(from, copy, { recursive: true });
          makeReadOnly(copy);
          renameSync(copy, to);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      }
      this.sharedLinks[name] = to;
    }
    if (keeper && originals.length > 0) {
      keeper.hide(originals);
      this.hiddenPaths = originals.map((path) => keeper.privatePath(path));
      this.guard = restoreOnExit(keeper, process, this.options.signal);
    }
    await this.options.kit.prepare();
    this.prepared = true;
  }

  agentSetup(hint: string, agent: number): AgentSetup {
    if (!this.prepared) throw new Error("TaskMode.prepare() must finish before agents are set up");
    const { goalObjective, ...setup } = this.options.kit.agentSetup({ hint, agent, links: this.sharedLinks, score: (input) => this.score(input) });
    return { ...setup, goal: { objective: goalObjective, verify: "test -f ../finished" }, links: this.sharedLinks };
  }

  warnings(): string[] {
    const warnings = this.options.kit.warnings();
    if (this.options.keeper)
      warnings.push(
        "The hidden data is protected only by a private, unguessable path and by the review rules; the agents' shell is NOT blocked from reading it by the operating system (ShellGuard is not built).",
      );
    return warnings;
  }

  /** Everything is put back and every agent is told, by its marker, that it may stop. Safe to call again. */
  finish(agents: readonly number[]): void {
    for (const agent of agents) {
      try {
        writeFileSync(this.options.layout.finishedMarker(agent), "the run has ended\n");
      } catch {
        // the agent's directory may be gone; the agent is cancelled anyway
      }
    }
    this.options.keeper?.restore();
    this.guard?.dispose();
    this.guard = undefined;
  }

  private async score(input: ScoreInput): Promise<{ result: EvalResult; selfReported: boolean }> {
    const { task, evalPool } = this.options;
    if (!task.evaluate) {
      const claimed = task.metric ? input.claim[task.metric.name] : Object.values(input.claim)[0];
      return { result: { status: "ok", score: claimed ?? null, metrics: input.claim, details: "" }, selfReported: true };
    }
    const release = await evalPool.acquire(input.signal);
    try {
      const timeout = AbortSignal.timeout((task.evalTimeoutMinutes ?? DEFAULT_EVAL_TIMEOUT_MINUTES) * 60_000);
      const signal = AbortSignal.any([input.signal, timeout]);
      const result = await task.evaluate({
        workDir: input.workDir,
        commit: input.commit,
        command: input.command,
        files: input.files,
        hidden: this.hiddenPaths,
        signal,
      });
      return { result, selfReported: false };
    } catch (error) {
      return {
        result: { status: "error", score: null, metrics: {}, details: `the evaluator failed: ${error instanceof Error ? error.message : String(error)}` },
        selfReported: false,
      };
    } finally {
      release();
    }
  }
}

function containsPath(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

/** Files are made read-only; directories stay writable so that a run directory can still be deleted. An agent with a shell can undo this: it is a guard against accidents, not a lock. */
function makeReadOnly(path: string): void {
  const entry = lstatSync(path);
  if (entry.isDirectory()) for (const name of readdirSync(path)) makeReadOnly(join(path, name));
  else if (!entry.isSymbolicLink()) chmodSync(path, 0o444);
}
