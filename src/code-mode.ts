import { cpSync, existsSync, mkdirSync, chmodSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "./clock.ts";
import type { EvalResult } from "./evaluation.ts";
import { type HiddenKeeper, type ProcessGuard, restoreOnExit } from "./hidden-keeper.ts";
import type { LlmClient } from "sakura-agent";
import { type AgentSetup, type Mode, type Progress, type Submission, type SubmitEffect, type SubmitEnv, type SubmitInfo, isCodeSubmission } from "./mode.ts";
import { CODE_GOAL_OBJECTIVE, codePrompt, codeRules, strategyRule } from "./prompts.ts";
import type { Pool } from "./pool.ts";
import type { RunLayout } from "./run-layout.ts";
import { safetyReview } from "./safety-review.ts";
import { createSubmitTool } from "./submit-tool.ts";
import { type CodeTask, better } from "./task.ts";

/** Large binary results are not worth keeping in every agent's Git history. */
const GITIGNORE = ["__pycache__/", "*.pyc", "*.pt", "*.pth", "*.ckpt", "*.npy", "*.npz", "*.pkl", "*.joblib", "*.safetensors", "*.onnx", ".venv/", "wandb/"];
const DEFAULT_EVAL_TIMEOUT_MINUTES = 10;

export interface CodeModeOptions {
  task: CodeTask;
  layout: RunLayout;
  clock: Clock;
  /** Evaluations wait here (one place per running evaluation). */
  evalPool: Pool;
  /** Present when the task has hidden data; code mode hides it in `prepare` and puts it back in `finish`. */
  keeper?: HiddenKeeper | undefined;
  /** The model that reviews the agents' commands; used when the task has review settings. */
  reviewClient: LlmClient;
}

/** Code mode: agents with a shell improve a result; each `submit` is scored by the task's evaluator (docs/05). */
export class CodeMode implements Mode {
  readonly kind = "code";
  readonly plannerSubject: string;
  readonly branchReview: CodeTask["branchReview"];
  private bestScore: number | null = null;
  private readonly options: CodeModeOptions;
  private readonly sharedLinks: Record<string, string> = {};
  private hiddenPaths: string[] = [];
  private prepared = false;
  private guard: ProcessGuard | undefined;

  constructor(options: CodeModeOptions) {
    this.options = options;
    this.plannerSubject = options.task.prompt;
    this.branchReview = options.task.branchReview;
  }

  restore(prior: Progress): void {
    this.bestScore = prior.bestScore;
  }

  /** Writes the result down; keeps the best verified score; ends the run when the target is reached. */
  accept(agent: number, submission: Submission, info: SubmitInfo, env: SubmitEnv): SubmitEffect {
    if (!isCodeSubmission(submission)) throw new Error("A code run got a math submission");
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
    const target = typeof task.stop === "object" ? task.stop.targetScore : undefined;
    if (target !== undefined && (direction === "max" ? result.score >= target : result.score <= target)) {
      env.recorder.event({ type: "target", agent, score: result.score });
      return { changed: true, finish: "target" };
    }
    return { changed: true };
  }

  progress(): Progress {
    return { proved: [], bestScore: this.bestScore };
  }

  endFields(): { bestScore?: number | null } {
    return { bestScore: this.bestScore };
  }

  async prepare(): Promise<void> {
    const { task, layout, keeper } = this.options;
    for (const [name, source] of Object.entries(task.files ?? {})) {
      const from = resolve(source);
      if (!existsSync(from)) throw new Error(`files['${name}']: ${from} does not exist`);
      const to = join(layout.sharedDir, name);
      if (!existsSync(to)) {
        mkdirSync(layout.sharedDir, { recursive: true });
        cpSync(from, to, { recursive: true });
        makeReadOnly(to);
      }
      this.sharedLinks[name] = to;
    }
    if (keeper && task.hidden && task.hidden.length > 0) {
      const originals = task.hidden.map((path) => resolve(path));
      keeper.hide(originals);
      this.hiddenPaths = originals.map((path) => keeper.privatePath(path));
      this.guard = restoreOnExit(keeper);
    }
    this.prepared = true;
  }

  agentSetup(hint: string, agent: number): AgentSetup {
    if (!this.prepared) throw new Error("CodeMode.prepare() must finish before agents are set up");
    const { task, clock } = this.options;
    const intervalMinutes = task.submitIntervalMinutes ?? 0;
    return {
      prompt: codePrompt(task.prompt),
      rules: [
        ...codeRules({
          hasEvaluator: task.evaluate !== undefined,
          metricName: task.metric?.name,
          dataNames: Object.keys(this.sharedLinks),
          submitIntervalMinutes: intervalMinutes,
        }),
        strategyRule(hint),
      ],
      goal: { objective: CODE_GOAL_OBJECTIVE, verify: "test -f ../finished" },
      files: {},
      links: this.sharedLinks,
      gitignore: GITIGNORE,
      builtinTools: ["read", "write", "edit", "bash"],
      confine: false,
      plugins: this.reviewPlugins(agent),
      tools: (submit, helpers) => [
        createSubmitTool({
          helpers,
          onSubmit: submit,
          metricName: task.metric?.name,
          direction: task.metric?.direction ?? "max",
          minIntervalMs: intervalMinutes * 60_000,
          now: () => clock.now(),
          evaluate: (input) => this.score(input),
        }),
      ],
    };
  }

  /** One safety-review plugin per agent: its rules know which directory is the agent's own. The reviewer model is shared and goes through the Gate. */
  private reviewPlugins(agent: number): NonNullable<AgentSetup["plugins"]> {
    const { task, layout } = this.options;
    if (task.review === false) return [];
    return [
      safetyReview({
        settings: task.review,
        client: this.options.reviewClient,
        agentDir: layout.agentDir(agent),
        runRoot: layout.root,
        sharedDir: layout.sharedDir,
        keeperDir: layout.keeperDir,
        hiddenOriginals: (task.hidden ?? []).map((path) => resolve(path)),
        protectedPaths: task.protect ?? [],
      }),
    ];
  }

  warnings(): string[] {
    const { task } = this.options;
    const warnings: string[] = [];
    if (task.review === false) warnings.push("The safety review is OFF: the agents' shell commands run unchecked, with your rights.");
    if (this.options.keeper)
      warnings.push(
        "The hidden data is protected only by a private, unguessable path and by the review rules; the agents' shell is NOT blocked from reading it by the operating system (ShellGuard is not built).",
      );
    if (!task.evaluate) warnings.push("There is no evaluator: the ranking uses the agents' own claims (self-reported).");
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

  private async score(input: {
    command: string;
    files: string[];
    commit: string | null;
    claim: Record<string, number>;
    signal: AbortSignal;
    workDir: string;
  }): Promise<{ result: EvalResult; selfReported: boolean }> {
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

/** Files are made read-only; directories stay writable so that a run directory can still be deleted. An agent with a shell can undo this: it is a guard against accidents, not a lock. */
function makeReadOnly(path: string): void {
  if (statSync(path).isDirectory()) for (const name of readdirSync(path)) makeReadOnly(join(path, name));
  else chmodSync(path, 0o444);
}
