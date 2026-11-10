/** What is written to `ledger.jsonl` (the source of truth about agents) and `events.jsonl` (what happened to the run). */

/** Every ledger line points back to the agent's work: which agent, where, and at which commit (null before the first commit). */
interface WorkPointer {
  ts: number;
  agent: number;
  workDir: string;
  commit: string | null;
}

export type LedgerEntry =
  /** One official submit: the proof file as sent and the result of the formal verification. */
  | (WorkPointer & { type: "submit"; code: string; proved: boolean; reason: string; steps: number; elapsedMs: number })
  | (WorkPointer & { type: "commit"; turn: number })
  | (WorkPointer & { type: "lifecycle"; event: "started" | "ended" | "stopped" | "rescued"; detail: string });

export type RunEvent =
  | { type: "run_start"; ts: number; task: string; ceiling: number; resumed: boolean }
  | {
      type: "rung";
      ts: number;
      from: number;
      to: number;
      reason: "advance" | "throttle";
      replies: number;
      throttles: number;
      latencyP50Ms: number;
      latencyP95Ms: number;
      tokensPerMinute: number;
    }
  | { type: "throttle"; ts: number; delayMs: number }
  | { type: "quota"; ts: number; message: string }
  | { type: "budget_refused"; ts: number; reason: string }
  | { type: "rescue"; ts: number; agent: number; rescue: number }
  | { type: "run_end"; ts: number; reason: string; tokensUsed: number; proved: number[] };
