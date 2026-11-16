import type { TaskPackage } from "../src/launch.ts";
import { defineTask } from "../src/task.ts";

/** Statements that need only Lean's core library (no Mathlib). `infinity run math-parity` and `infinity run math-odd-sum` (folders of tasks/) each use one. */
export const STATEMENTS = {
  parity: "∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1",
  // the sum of the first n odd numbers is n squared, written with the core library only
  "odd-sum": "∀ n : Nat, (List.range n).foldl (fun acc i => acc + (2 * i + 1)) 0 = n * n",
} as const;

export type StatementName = keyof typeof STATEMENTS;

/** The math task package: agents try to prove one statement in Lean 4; the run ends when the first proof is accepted. Needs `lean` and `lake` on the PATH. */
export function mathPackage(statement: StatementName): TaskPackage {
  return {
    name: `math-${statement}`,
    summary: `Prove "${STATEMENTS[statement]}" in Lean 4 (core library); the run stops at the first accepted proof`,
    defaults: { tokens: 3_000_000 },
    build({ agents, model, tokens, runsDir }) {
      return defineTask({
        name: statement,
        mode: "math",
        statement: STATEMENTS[statement],
        agents,
        model,
        stop: "first-success",
        leanPool: 2,
        sandbox: false, // the owner decided: no sandbox; a proof file runs with your rights
        ...(tokens === undefined ? {} : { tokens }),
        stuckMinutes: 10,
        runsDir,
      });
    },
  };
}
