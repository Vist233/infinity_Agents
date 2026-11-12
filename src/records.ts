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
  /** Code mode: one official submit. `entry` is the contents of the files the agent listed (cut at a size limit), the commit holds everything. */
  | (WorkPointer & {
      type: "result";
      command: string;
      entry: string;
      files: string[];
      status: "ok" | "error";
      score: number | null;
      metrics: Record<string, number>;
      details: string;
      selfReported: boolean;
      steps: number;
      elapsedMs: number;
    })
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
  | { type: "throttle"; ts: number; delayMs: number; cause?: "provider" | "connection" }
  | { type: "quota"; ts: number; message: string }
  | { type: "budget_refused"; ts: number; reason: string }
  | { type: "rescue"; ts: number; agent: number; rescue: number }
  | { type: "run_end"; ts: number; reason: string; tokensUsed: number; proved: number[]; bestScore?: number | null }
  /** Said loudly at the start and in the report: something is weaker than the task author may expect (no review, hidden data not protected, ...). */
  | { type: "warning"; ts: number; message: string }
  /** The safety review (or the hard rules in front of it) refused an action of an agent. */
  | { type: "action_denied"; ts: number; agent: number; tool: string; decidedBy: string; reason: string }
  /** One branch review. Older logs and failed reviews can lack a snapshot. */
  | {
      type: "review";
      ts: number;
      agent: number;
      outcome: "ok" | "steer" | "error";
      ms: number;
      tokens: number;
      cacheRead?: number;
      text?: string;
      snapshot?: ReviewSnapshot;
    }
  /** The branch review was switched off for the rest of the run, or ended with these skip counts. */
  | { type: "review_off"; ts: number; reason: string }
  | { type: "review_skips"; ts: number; skips: Record<string, number> }
  /** At the end of the run: processes still working in the run directory (agents' background jobs) were stopped. `killedHard` needed SIGKILL after the polite stop. */
  | { type: "leftover_processes"; ts: number; found: number; killedHard: number }
  /** The pressure brake went on or off (docs/16 section D): the machine was over the limits for three readings in a row, or back under them. */
  | { type: "pressure_hold"; ts: number; on: boolean; rung: number; loadPerCore: number; cpuPressure10: number | null }
  /** A heavy command (kind "cpu": a bash command at the gate) or a GPU job (kind "gpu": a command started with the `gpu` shim) waited a second or more for a slot. */
  | { type: "slot_wait"; ts: number; kind: "cpu" | "gpu"; agent: number; waitMs: number }
  /** At the end of a run with the gate: heavy commands run, how many waited, the waiting time, and the share of slot time that was busy (0 to 1). */
  | {
      type: "slot_summary";
      ts: number;
      kind: "cpu" | "gpu";
      slots: number;
      commands: number;
      waited: number;
      totalWaitMs: number;
      maxWaitMs: number;
      utilisation: number;
    }
  /** A submit reached the task's target score. */
  | { type: "target"; ts: number; agent: number; score: number };
import type { ReviewSnapshot } from "./review-snapshot.ts";

/** A run event as the caller writes it: the recorder adds the time. */
export type WithoutTs<T> = T extends unknown ? Omit<T, "ts"> : never;
