import type { Plugin, Tool } from "sakura-agent";
import type { Clock } from "./clock.ts";
import type { RunRecorder } from "./run-recorder.ts";
import type { RunLayout } from "./run-layout.ts";
import type { BranchReviewSettings } from "./task.ts";
import type { EvalResult } from "./evaluation.ts";

/** One official submit: the command that produced the result, the contents of the listed files, and what the evaluator (or the agent, if self-reported) said. The ledger line is made from it. */
export interface Submission {
  command: string;
  files: string[];
  entry: string;
  result: EvalResult;
  selfReported: boolean;
}

/** Helpers the worker gives to a mode's tools. */
export interface ToolHelpers {
  /** The agent's work directory (absolute). */
  workDir: string;
  /** Commits the work directory now (after the tools' own writes) and returns the commit, so that a tool can act on exactly that state. */
  commitNow(): Promise<string | null>;
}

export type BuiltinTool = "read" | "write" | "edit" | "bash";

/** Everything the worker needs to start one agent of a mode. */
export interface AgentSetup {
  /** The first message of the agent. */
  prompt: string;
  /** Rules added to the system prompt (the common rules and the strategy hint). */
  rules: string[];
  /** Every agent starts with a goal; `verify` is a shell command run in the work directory that must succeed before the agent may stop. */
  goal: { objective: string; verify: string };
  /** Files put read-only into the work directory when it is created (the statement, a README, ...). */
  files: Record<string, string>;
  /** Name -> absolute path: shared read-only data, linked into the work directory (and kept out of Git). */
  links?: Record<string, string>;
  /** Lines for the work directory's `.gitignore` (large binary results that Git should not hold). */
  gitignore?: string[];
  builtinTools: BuiltinTool[];
  /** Keep the file tools inside the work directory (math: yes; a mode with a shell cannot get this protection). */
  confine: boolean;
  /** Plugins added to the agent's own (the safety review and the limits on commands of code mode). */
  plugins?: Plugin[];
  /** After this many milliseconds a running shell command is moved to the background by the shell tool (the framework's default is 120000); code mode sets a huge value so that commands never leave the foreground. */
  bashSoftTimeoutMs?: number;
  /** The mode's own tools. `submit` is the official call: the worker commits, counts and records, the orchestrator decides what it means. */
  tools(submit: (submission: Submission) => Promise<void>, helpers: ToolHelpers): Tool[];
}

/** What the `submit` tool asks the mode to score. */
export interface ScoreInput {
  command: string;
  files: string[];
  commit: string | null;
  /** Only when the task has no evaluator: the agent's own numbers. */
  claim: Record<string, number>;
  signal: AbortSignal;
  workDir: string;
}

export type ScoreFn = (input: ScoreInput) => Promise<{ result: EvalResult; selfReported: boolean }>;

/** The tools of the agents and what goes with them: what a proof task and a program task do not share. The mode owns everything else. */
export interface Kit {
  /** What kind of strategies the planner is asked for. */
  readonly plannerKind: "math" | "code";
  /** What the planner is told to plan strategy hints for. */
  readonly plannerSubject: string;
  /** Start-up work that can fail the run (compile the statement). */
  prepare(): Promise<void>;
  /** Things the task author should be told at the start. */
  warnings(): string[];
  /** One agent's setup, except the goal's check and the shared links, which are the mode's. */
  agentSetup(args: {
    hint: string;
    agent: number;
    links: Record<string, string>;
    score: ScoreFn;
  }): Omit<AgentSetup, "goal" | "links"> & { goalObjective: string };
}

/** What the worker tells the mode about one official submit. */
export interface SubmitInfo {
  commit: string | null;
  steps: number;
  elapsedMs: number;
}

/** What a mode may use to take a submit: the run's records, its layout and its clock. */
export interface SubmitEnv {
  recorder: RunRecorder;
  layout: RunLayout;
  clock: Clock;
}

/** What the mode says about the run so far: the best verified score. Saved in the state file. */
export interface Progress {
  bestScore: number | null;
}

/** What the orchestrator does after a submit. */
export interface SubmitEffect {
  /** The progress changed: save the state file. */
  changed: boolean;
  /** End the run for this reason. */
  finish?: string;
}

/**
 * What the orchestrator knows about a task. It runs agents, a ladder, a gate and a ledger; everything about the tools of the agents, the files, the hidden
 * data and the scoring of a submit is behind this interface (one implementation, `TaskMode`; the seam is for tests).
 */
export interface Mode {
  /** Start-up work that can fail the run (compile the statement, find the keeper's files, ...). */
  prepare(): Promise<void>;
  /** What kind of strategies the planner is asked for: proof strategies or experiment strategies. */
  readonly plannerKind: "math" | "code";
  /** The branch review's settings, when the mode has one. */
  readonly branchReview?: BranchReviewSettings | undefined;
  /** Takes the progress of a run that is resumed. */
  restore(prior: Progress): void;
  /** Takes one official submit: writes it down, keeps what the mode keeps (accepted proofs, best score) and says whether the run is over. */
  accept(agent: number, submission: Submission, info: SubmitInfo, env: SubmitEnv): SubmitEffect;
  progress(): Progress;
  /** The extra fields of the end of the run (`bestScore`). */
  endFields(): { bestScore?: number | null };
  /** What the planner is told to plan strategy hints for. */
  readonly plannerSubject: string;
  agentSetup(hint: string, agent: number): AgentSetup;
  /** Things the task author should be told at the start (for example: the review is off). Written as warning events and shown in the report. */
  warnings?(): string[];
  /** Last work of the run, when it ends for any reason (restore hidden data, write end markers). Must not throw; may be called more than once. */
  finish?(agents: readonly number[]): void;
}
