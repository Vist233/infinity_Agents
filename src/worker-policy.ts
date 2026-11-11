import type { RunEndReason } from "sakura-agent";

export type CancelReason = "retire" | "finish" | "stuck" | "rescue";

export interface AgentEnd {
  reason: RunEndReason | "failed";
  cancelled?: CancelReason;
  detail?: string;
}

/** Pauses in a row, without a single reply in between, after which an agent is given up. */
export const MAX_PAUSES_WITHOUT_REPLY = 20;

export interface FinishedRun {
  reason: RunEndReason;
  pause?: string | undefined;
  error?: string | undefined;
}

export type NextStep =
  /** Start again with the rescue message. */
  | { type: "rescue" }
  /** Wait, then go on with the same session. */
  | { type: "wait" }
  | { type: "end"; end: AgentEnd };

/** What a worker does when one run of its agent is over (pure: the worker acts on the answer). */
export function afterRun(state: { cancelled: CancelReason | undefined; run: FinishedRun; gateStopped: boolean; pausesWithoutReply: number }): NextStep {
  const { cancelled, run } = state;
  if (cancelled === "rescue") return { type: "rescue" };
  if (cancelled) return { type: "end", end: { reason: "cancelled", cancelled } };
  // the review's circuit breaker: too many refusals in a row. The agent ends as a failure and the ladder starts a new one.
  if (run.reason === "paused" && run.pause === "approval")
    return { type: "end", end: { reason: "failed", detail: "stopped by the review's circuit breaker (too many refused actions)" } };
  if (run.reason === "paused" && !state.gateStopped && state.pausesWithoutReply < MAX_PAUSES_WITHOUT_REPLY) return { type: "wait" };
  return { type: "end", end: { reason: run.reason, ...(run.error ? { detail: run.error } : {}) } };
}
