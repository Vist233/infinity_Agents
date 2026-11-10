import type { LeanRunner } from "./lean-runner.ts";
import { MathMode } from "./math-mode.ts";
import type { Mode } from "./mode.ts";
import type { RunLayout } from "./run-layout.ts";
import type { TaskDefinition } from "./task.ts";
import type { Verifier } from "./verifier.ts";

/** What tests may replace in a mode. */
export interface ModeOverrides {
  leanRunner?: LeanRunner | undefined;
  verifier?: Verifier | undefined;
}

/** The one place that knows which kinds of task exist. */
export function createMode(task: TaskDefinition, layout: RunLayout, overrides: ModeOverrides): Mode {
  switch (task.mode) {
    case "math":
      return new MathMode({ task, leanDir: layout.leanDir, leanRunner: overrides.leanRunner, verifier: overrides.verifier });
  }
}
