import type { LeanRunner } from "../../src/lean-runner.ts";
import { type ModeContext, createMode } from "../../src/mode-factory.ts";
import type { Mode } from "../../src/mode.ts";
import type { Verifier } from "../../src/verifier.ts";

/** For `RunOptions.mode`: a proof task with a fake verifier or a fake Lean runner. */
export const mathModeWith =
  (parts: { verifier?: Verifier; leanRunner?: LeanRunner }) =>
  (context: ModeContext): Mode =>
    createMode(context, parts);
