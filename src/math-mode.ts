import { cpus } from "node:os";
import { createLeanTool } from "./lean-tool.ts";
import { createLeanRunner, type LeanRunner } from "./lean-runner.ts";
import { findLean } from "./lean-setup.ts";
import type { Mode } from "./mode.ts";
import { Pool, defaultLeanPoolSize } from "./pool.ts";
import { GOAL_OBJECTIVE, MATH_RULES, strategyRule, taskPrompt } from "./prompts.ts";
import type { TaskDefinition } from "./task.ts";
import { type Verifier, createVerifier, statementSource } from "./verifier.ts";

export interface MathModeOptions {
  task: TaskDefinition;
  /** Where the compiled statement and the scratch directories live. */
  leanDir: string;
  /** For tests: a fake prover or a ready verifier. */
  leanRunner?: LeanRunner | undefined;
  verifier?: Verifier | undefined;
}

/** Math mode: prove a Lean statement; the official check is the verifier. */
export class MathMode implements Mode {
  readonly name = "math";
  readonly plannerSubject: string;
  private readonly options: MathModeOptions;
  private verifier: Verifier | undefined;

  constructor(options: MathModeOptions) {
    this.options = options;
    this.verifier = options.verifier;
    this.plannerSubject = options.task.statement;
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
