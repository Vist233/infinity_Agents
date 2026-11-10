import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LadderState } from "./ladder.ts";

/** What a restart needs. Everything else is in the logs and in the agents' session files. */
export interface RunState {
  version: 1;
  task: string;
  startedAt: number;
  hints: string[];
  ladder: LadderState;
  proved: number[];
  tokensUsed: number;
  requests: number;
  /** Agents that ended without finishing their goal, for the guard against endless replacement. */
  failures: number;
  /** Why the run ended, or null while it runs (a state with null after a crash means: resume). */
  finished: string | null;
}

export function saveState(path: string, state: RunState): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`);
  renameSync(temporary, path);
}

export function loadState(path: string): RunState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as RunState;
    return state.version === 1 ? state : undefined;
  } catch {
    return undefined;
  }
}
