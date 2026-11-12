import { existsSync, statSync } from "node:fs";
import { JsonlFile } from "./jsonl.ts";
import type { LedgerEntry, RunEvent } from "./records.ts";
import { runLayout } from "./run-layout.ts";
import { loadState } from "./run-state.ts";

/** What a run directory says about its run, read from the files only (a run in this process or another, finished or not). */
export interface RunStatus {
  runDir: string;
  task: string | null;
  /** `running`: the files changed in the last three minutes and no end is recorded. `stopped`: no end recorded and quiet (a crash or a kill; resume continues it). */
  state: "empty" | "running" | "stopped" | "finished";
  /** Why the run ended, when it did. */
  reason: string | null;
  startedAt: number | null;
  tokensUsed: number;
  requests: number;
  bestScore: number | null;
  agentsLive: number;
  /** Agents alive at once now (the rung of the ladder), or null before the first rung. */
  rung: number | null;
  /** Results recorded by the evaluator or self-reported. */
  results: number;
  warnings: string[];
}

const QUIET_MS = 3 * 60_000;

/** The status of a run from its files. `now` is for tests. */
export function readRunStatus(runDir: string, now: number = Date.now()): RunStatus {
  const layout = runLayout(runDir);
  const state = loadState(layout.state);
  const events = new JsonlFile<RunEvent>(layout.events).readAll();
  const results = new JsonlFile<LedgerEntry>(layout.ledger).readAll().filter((entry) => entry.type === "result");
  const end = events.findLast((event) => event.type === "run_end");
  const warnings = events.flatMap((event) => (event.type === "warning" ? [event.message] : []));
  const touched = [layout.state, layout.events].filter(existsSync).map((file) => statSync(file).mtimeMs);
  const quiet = touched.length === 0 || now - Math.max(...touched) > QUIET_MS;
  const finished = state?.finished ?? (end?.type === "run_end" ? end.reason : null);
  const rung = state ? (state.ladder.rungs[state.ladder.rungIndex] ?? null) : null;
  return {
    runDir: layout.root,
    task: state?.task ?? null,
    state: !state && events.length === 0 ? "empty" : finished !== null ? "finished" : quiet ? "stopped" : "running",
    reason: finished,
    startedAt: state?.startedAt ?? null,
    tokensUsed: state?.tokensUsed ?? 0,
    requests: state?.requests ?? 0,
    bestScore: state?.bestScore ?? null,
    agentsLive: state ? Object.keys(state.ladder.live).length : 0,
    rung,
    results: results.length,
    warnings,
  };
}

/** The events of a run from position `from` on (default: all), and the position to ask for next time. Read from the file, so it works for any run directory. */
export function readRunEvents(runDir: string, from = 0): { events: RunEvent[]; next: number } {
  const all = new JsonlFile<RunEvent>(runLayout(runDir).events).readAll();
  return { events: all.slice(from), next: all.length };
}
