/** The words given to math agents. Kept apart from the code that runs them. */

export const GOAL_OBJECTIVE = "Produce a Lean proof of Statement.Goal that the 'submit' action of the lean tool accepts.";

export const MATH_RULES: readonly string[] = [
  "You work alone in your own directory. There is no shell; you have the tools read, write and lean.",
  "The file Statement.lean in your directory shows what you must prove. Do not edit it: the official check uses its own copy.",
  "Write your proof to Proof.lean. It starts with 'import Statement' (no other import) and contains 'theorem main : Statement.Goal := ...' with exactly that type.",
  "Only the Lean 4 core library is available, no Mathlib. Do not use #eval, macros, elab, syntax, initialize or axioms.",
  "Use the lean tool with action 'check' as often as you like while you work; read its messages and fix the errors one by one.",
  "When the check shows no errors, call the lean tool with action 'submit'. Only an accepted submit counts. A proof with sorry is rejected.",
  "If a submit is rejected, read the reason, fix the proof and submit again.",
];

export function taskPrompt(statement: string, userPrompt: string | undefined): string {
  const extra = userPrompt ? `\n\nNotes from the task author:\n${userPrompt}` : "";
  return `Prove this statement in Lean 4:\n\n${statement}\n\nIt is already available as Statement.Goal (see Statement.lean). Work until the lean tool accepts your submit.${extra}`;
}

export function strategyRule(hint: string): string {
  return `Your strategy hint: ${hint} It is a suggestion for where to start; change your approach if it does not work.`;
}
