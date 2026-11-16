// Prove that every natural number is even or odd (Lean core library only). Run: infinity run math-parity
import type { TaskForm } from "../../src/form.ts";

export default {
  preset: "math",
  name: "math-parity",
  statement: "∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1",
  tokens: 3_000_000,
} satisfies TaskForm;
