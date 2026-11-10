import type { Tool } from "sakura-agent";
import type { Verdict } from "./verifier.ts";

/** What a mode reports for one official submit; the ledger line is made from it. (Math shaped for now; generalised when the code mode needs it.) */
export interface Submission {
  code: string;
  verdict: Verdict;
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
  builtinTools: BuiltinTool[];
  /** Keep the file tools inside the work directory (math: yes; a mode with a shell cannot get this protection). */
  confine: boolean;
  /** The mode's own tools. `submit` is the official call: the worker commits, counts and records, the orchestrator decides what it means. */
  tools(submit: (submission: Submission) => Promise<void>): Tool[];
}

/**
 * What the orchestrator knows about a kind of task. It runs agents, a ladder, a gate and a ledger; everything specific to
 * proving theorems (or, later, to scoring code) is behind this interface.
 */
export interface Mode {
  readonly name: string;
  /** Start-up work that can fail the run (compile the statement, find the keeper's files, ...). */
  prepare(): Promise<void>;
  /** What the planner is told to plan strategy hints for. */
  readonly plannerSubject: string;
  agentSetup(hint: string): AgentSetup;
}
