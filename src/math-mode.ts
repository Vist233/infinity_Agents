import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { createLeanTool } from "./lean-tool.ts";
import { createLeanRunner, type LeanRunner } from "./lean-runner.ts";
import { findLean } from "./lean-setup.ts";
import { type Mode, type Progress, type Submission, type SubmitEffect, type SubmitEnv, type SubmitInfo, isCodeSubmission } from "./mode.ts";
import { Pool, defaultLeanPoolSize } from "./pool.ts";
import { GOAL_OBJECTIVE, MATH_RULES, strategyRule, taskPrompt } from "./prompts.ts";
import type { MathTask } from "./task.ts";
import { type Verifier, createVerifier, statementSource } from "./verifier.ts";

export interface MathModeOptions {
  task: MathTask;
  /** Where the compiled statement and the scratch directories live. */
  leanDir: string;
  /** For tests: a fake prover or a ready verifier. */
  leanRunner?: LeanRunner | undefined;
  verifier?: Verifier | undefined;
}

/** Math mode: prove a Lean statement; the official check is the verifier of docs/02 section 8. */
export class MathMode implements Mode {
  readonly kind = "math";
  readonly plannerSubject: string;
  private readonly proved: number[] = [];
  private readonly options: MathModeOptions;
  private verifier: Verifier | undefined;

  constructor(options: MathModeOptions) {
    this.options = options;
    this.verifier = options.verifier;
    this.plannerSubject = options.task.statement;
  }

  restore(prior: Progress): void {
    this.proved.splice(0, this.proved.length, ...prior.proved);
  }

  /** Writes the verdict down; an accepted proof gets its marker, and with `first-success` it ends the run. */
  accept(agent: number, submission: Submission, info: SubmitInfo, env: SubmitEnv): SubmitEffect {
    if (isCodeSubmission(submission)) throw new Error("A math run got a code submission");
    const { code, verdict } = submission;
    env.recorder.submit(agent, { code, proved: verdict.proved, reason: verdict.reason, ...info });
    if (!verdict.proved) return { changed: false };
    writeFileSync(env.layout.provedMarker(agent), `accepted by the orchestrator at ${new Date(env.clock.now()).toISOString()}\n`);
    this.proved.push(agent);
    return this.options.task.stop === "first-success" ? { changed: true, finish: "proved" } : { changed: true };
  }

  progress(): Progress {
    return { proved: [...this.proved], bestScore: null };
  }

  endFields(): { bestScore?: number | null } {
    return {};
  }

  async prepare(): Promise<void> {
    if (this.verifier) return;
    const { task, leanDir } = this.options;
    const runner =
      this.options.leanRunner ??
      createLeanRunner({
        leanBin: (await findLean()).leanBin,
        pool: new Pool(task.leanPool ?? defaultLeanPoolSize(cpus().length)),
        sandbox: task.sandbox ?? false,
      });
    this.verifier = await createVerifier({ runner, leanDir, statement: task.statement });
  }

  agentSetup(hint: string): ReturnType<Mode["agentSetup"]> {
    const verifier = this.verifier;
    if (!verifier) throw new Error("MathMode.prepare() must finish before agents are set up");
    const { task } = this.options;
    return {
      prompt: taskPrompt(task.statement, task.prompt),
      rules: [...MATH_RULES, strategyRule(hint)],
      goal: { objective: GOAL_OBJECTIVE, verify: "test -f ../proved" },
      files: { "Statement.lean": statementSource(task.statement) },
      builtinTools: ["read", "write"],
      confine: true,
      tools: (submit) => [createLeanTool({ verifier, onSubmit: submit })],
    };
  }
}
