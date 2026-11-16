// Prove that the sum of the first n odd numbers is n squared (needs induction; Lean core library only). Run: infinity run math-odd-sum
import type { TaskForm } from "../../src/form.ts";

export default {
  preset: "math",
  name: "math-odd-sum",
  statement: "∀ n : Nat, (List.range n).foldl (fun acc i => acc + (2 * i + 1)) 0 = n * n",
  tokens: 3_000_000,
} satisfies TaskForm;
