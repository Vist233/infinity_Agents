import { MathMode } from "../../src/math-mode.ts";
import type { LeanRunner } from "../../src/lean-runner.ts";
import type { ModeContext } from "../../src/mode-factory.ts";
import type { MathTask } from "../../src/task.ts";
import type { Verifier } from "../../src/verifier.ts";

/** For `RunOptions.mode`: the math mode with a fake verifier or a fake Lean runner. */
export const mathModeWith =
  (parts: { verifier?: Verifier; leanRunner?: LeanRunner }) =>
  (context: ModeContext): MathMode =>
    new MathMode({ task: context.task as MathTask, leanDir: context.layout.leanDir, ...parts });
