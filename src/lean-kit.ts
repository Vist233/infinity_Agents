import { cpus } from "node:os";
import { createLeanRunner, type LeanRunner } from "./lean-runner.ts";
import { findLean } from "./lean-setup.ts";
import { createLeanTool } from "./lean-tool.ts";
import type { Kit } from "./mode.ts";
import { Pool, defaultLeanPoolSize } from "./pool.ts";
import { GOAL_OBJECTIVE, MATH_RULES, strategyRule, taskPrompt } from "./prompts.ts";
import type { ToolsSetting } from "./task.ts";
import { type Verifier, createVerifier, statementSource } from "./verifier.ts";

export interface LeanKitOptions {
  tools: Extract<ToolsSetting, { kind: "lean" }>;
  /** Extra words for the agents. */
  prompt?: string | undefined;
  /** Where the compiled statement and the scratch directories live. */
  leanDir: string;
  /** For tests: a fake prover or a ready verifier. */
  leanRunner?: LeanRunner | undefined;
  verifier?: Verifier | undefined;
}

/** Agents with file tools only (confined to their directory) and the `lean` tool: `check` is free, `submit` is judged by the verifier (docs/02 section 8). The score is 1 for an accepted proof. */
export function leanKit(options: LeanKitOptions): Kit {
  const { tools } = options;
  let verifier = options.verifier;
  return {
    plannerKind: "math",
    plannerSubject: tools.statement,
    async prepare() {
      if (verifier) return;
      const runner =
        options.leanRunner ??
        createLeanRunner({
          leanBin: (await findLean()).leanBin,
          pool: new Pool(tools.leanPool ?? defaultLeanPoolSize(cpus().length)),
          sandbox: tools.sandbox ?? false,
        });
      verifier = await createVerifier({ runner, leanDir: options.leanDir, statement: tools.statement });
    },
    warnings: () => [],
    agentSetup({ hint }) {
      const ready = verifier;
      if (!ready) throw new Error("The Lean kit must be prepared before agents are set up");
      return {
        prompt: taskPrompt(tools.statement, options.prompt),
        rules: [...MATH_RULES, strategyRule(hint)],
        goalObjective: GOAL_OBJECTIVE,
        files: { "Statement.lean": statementSource(tools.statement) },
        builtinTools: ["read", "write"],
        confine: true,
        tools: (submit) => [createLeanTool({ verifier: ready, onSubmit: submit })],
      };
    },
  };
}
