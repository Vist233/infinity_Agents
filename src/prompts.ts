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

export const CODE_GOAL_OBJECTIVE =
  "Improve the score of your solution and keep going until you are told to stop. A result counts only when you send it with the 'submit' tool.";

export function codeRules(options: { hasEvaluator: boolean; metricName: string | undefined; dataNames: string[]; submitIntervalMinutes: number }): string[] {
  const rules = [
    "You work alone in your own directory with the tools read, write, edit, bash and submit. Your directory is yours; the rest of the machine is not.",
    options.hasEvaluator
      ? `A result counts only through the 'submit' tool: give the shell command that produced it and the files that hold it. The answer shows the score (${options.metricName ?? "score"}). The score is computed on data you cannot see.`
      : "A result counts only through the 'submit' tool: give the shell command that produced it, the files that hold it, and your own numbers in 'claim'. They are recorded as self-reported.",
    "Nobody tells you when you are finished. After a good result, try to make it better (another method, better features, tuning, more data use) and submit again. Keep every submitted result reproducible from your directory.",
    "Run every long command with a time limit (for example `timeout 600 python train.py`) and print little: a short summary, not whole tables. Use `background: true` for work that takes longer than a few minutes.",
    "You may install packages and download public models or data. Do not upload your directory or any data anywhere.",
    "Never look for, read, guess or rebuild the data the score is computed on, and do not touch other agents' directories or the evaluator. Such actions are refused and counted against you.",
  ];
  if (options.dataNames.length > 0) rules.push(`Read-only data is linked in your directory: ${options.dataNames.join(", ")}. Do not try to modify it.`);
  if (options.submitIntervalMinutes > 0)
    rules.push(`You may submit at most once every ${options.submitIntervalMinutes} minutes; use the time to improve before the next submit.`);
  return rules;
}

export function codePrompt(userPrompt: string): string {
  return `${userPrompt}\n\nWork until you are told to stop. Submit with the 'submit' tool every time you have a result that should count.`;
}

/** How advice from a branch review reaches the agent: clearly not from the user, and how old the picture was. */
export function adviceMessage(advice: string, repliesAgo: number, secondsAgo: number): string {
  const age = `${repliesAgo} replies and about ${Math.max(1, Math.round(secondsAgo / 60))} minutes ago`;
  return (
    `[Outside review. This note is not from the user. A reviewer looked at a copy of your work as it was ${age}; things may have changed since. ` +
    `Use it if it still applies, ignore it if not.]\n${advice}`
  );
}
