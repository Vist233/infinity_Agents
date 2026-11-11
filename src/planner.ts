import type { LlmClient } from "sakura-agent";

/** Used when the planner call fails or answers badly, and to fill up when it gives fewer hints than agents. Lean 4 without Mathlib. */
export const FALLBACK_HINTS: readonly string[] = [
  "Try the simplest automation first: omega, simp, decide, rfl, then combine them.",
  "Prove it by induction on the main variable, with the induction hypothesis written out explicitly.",
  "Split into cases (cases, rcases, by_cases, match) and close each case separately.",
  "Unfold the definitions and rewrite step by step with rw and simp only, reading the goal after every step.",
  "Prove a helper lemma first, then use it in the main theorem.",
  "Work backwards: state the last step you need as a 'have', and then prove the steps before it.",
  "Argue by contradiction (by_contra) and look for a contradiction with omega or simp.",
  "Search the core library for a matching lemma (exact?, apply?, #check on Nat.* names) and use it.",
  "Strengthen the statement for the induction, prove the stronger lemma, and derive the goal.",
  "Use strong induction (Nat.strong_induction_on) when the usual induction step is not enough.",
  "Write the proof as a term (fun n => ...) with Or.inl / Or.inr and Nat lemmas, without tactics.",
  "Use calc blocks so that each equality step is checked on its own.",
];

/** The same for code tasks: no task-specific knowledge, only ways of working that fit most problems with a score. */
export const CODE_FALLBACK_HINTS: readonly string[] = [
  "Build a quick, solid baseline first and submit it early, then improve it step by step.",
  "Look hard at the data first (types, missing values, class balance, leakage), and let what you find choose the method.",
  "Use gradient boosted trees and spend your time on tuning them with a time limit per run.",
  "Try a different model family from the usual one (for example linear, nearest neighbours, neural network) and compare on a validation split.",
  "Work on features: transformations, interactions, encodings; measure each change on a validation split.",
  "Use cross-validation to choose between ideas, and submit only what is clearly better than your best.",
  "Build an ensemble of several different models (averaging or stacking) from your own earlier results.",
  "Search for the best hyper-parameters with a small, time-limited random search before any long training.",
  "Try to make training much faster (sampling, early stopping, fewer features) so that you can test more ideas.",
  "Look at the examples your best model gets wrong and design something for them.",
  "Start from a simple, well-known recipe for this kind of problem and push it as far as it goes before trying anything exotic.",
  "Use a neural network with careful scaling of the inputs and a learning-rate schedule, and compare it with trees.",
];

const PLANNER_SYSTEM =
  "You plan a team of agents that each try to prove one statement in Lean 4 (core library only, no Mathlib). Answer with a JSON array of strings and nothing else.";

export interface PlanOptions {
  client: LlmClient;
  /** What kind of task the hints are for (default math). */
  kind?: "math" | "code";
  /** The proposition to prove, as Lean source. */
  statement: string;
  /** How many different hints to ask for. */
  count: number;
  signal?: AbortSignal;
}

/**
 * One model call at the start: a different strategy hint for every agent. Any failure (an error, text that is not a list) gives the fixed list,
 * so the run never depends on the planner. A cancelled call is passed on.
 */
export async function planHints(options: PlanOptions): Promise<string[]> {
  const signal = options.signal ?? new AbortController().signal;
  try {
    const text = await askPlanner(options, signal);
    return completeWithFallback(parseHints(text), options.count, options.kind);
  } catch (error) {
    if (signal.aborted) throw error;
    return completeWithFallback([], options.count, options.kind);
  }
}

async function askPlanner(options: PlanOptions, signal: AbortSignal): Promise<string> {
  const request = {
    system: options.kind === "code" ? CODE_PLANNER_SYSTEM : PLANNER_SYSTEM,
    messages: [
      {
        role: "user" as const,
        ts: Date.now(),
        content: [
          {
            type: "text" as const,
            text:
              options.kind === "code"
                ? `Task:\n${options.statement}\n\nWrite ${options.count} different one-sentence strategy hints, one per agent, each pointing to a different way to get a better score.`
                : `Statement:\n${options.statement}\n\nWrite ${options.count} different one-sentence strategy hints, one per agent, each pointing to a different way to prove it.`,
          },
        ],
      },
    ],
    tools: [],
    maxTokens: 1500,
  };
  let text = "";
  for await (const event of options.client.stream(request, signal)) if (event.type === "text_delta") text += event.delta;
  return text;
}

function parseHints(text: string): string[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
  } catch {
    return [];
  }
}

const CODE_PLANNER_SYSTEM =
  "You plan a team of agents that each work on the same task with a score (code, data, machine learning). Answer with a JSON array of strings and nothing else.";

function completeWithFallback(hints: string[], count: number, kind: "math" | "code" = "math"): string[] {
  const unique = [...new Set(hints)];
  const filler = (kind === "code" ? CODE_FALLBACK_HINTS : FALLBACK_HINTS).filter((hint) => !unique.includes(hint));
  return [...unique, ...filler].slice(0, Math.max(count, 1));
}

/** Agent numbers start at 1 and are never reused, so a replacement agent gets the next hint of the list (and the list repeats when it ends). */
export function hintFor(hints: readonly string[], agent: number): string {
  if (hints.length === 0) return FALLBACK_HINTS[0] ?? "";
  return hints[(agent - 1) % hints.length] ?? "";
}
