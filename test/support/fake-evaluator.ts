import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalContext, EvalResult, Evaluator } from "../../src/evaluation.ts";

export interface FakeEvaluator {
  evaluate: Evaluator;
  calls: EvalContext[];
  /** How many evaluations ran at the same moment, at most. */
  peak: () => number;
  /** What the evaluator could see of the original place of the hidden file while it ran. */
  originalVisible: boolean[];
}

/** Score = the number in pred.txt (committed state of the work directory) divided by the number in the hidden file. */
export function createFakeEvaluator(options: { original: string; delayMs?: number; failOnCall?: number }): FakeEvaluator {
  let active = 0;
  let peak = 0;
  const fake: FakeEvaluator = {
    calls: [],
    originalVisible: [],
    peak: () => peak,
    evaluate: async (context) => {
      fake.calls.push(context);
      fake.originalVisible.push(existsSync(options.original));
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        if (options.failOnCall === fake.calls.length) throw new Error("evaluator crashed");
        const truth = Number(readFileSync(context.hidden[0] as string, "utf8"));
        const value = Number(readFileSync(join(context.workDir, "pred.txt"), "utf8"));
        const result: EvalResult = { status: "ok", score: value / truth, metrics: { value }, details: "" };
        return result;
      } finally {
        active -= 1;
      }
    },
  };
  return fake;
}
