import type { LedgerEntry } from "./records.ts";
import { renderCsv } from "./csv.ts";
import { type Direction, better } from "./task.ts";

export interface CodeRow {
  rank: number;
  agent: number;
  /** The agent's best score (null when it never had a scored result). */
  score: number | null;
  selfReported: boolean;
  submits: number;
  errors: number;
  commit: string | null;
  workDir: string;
}

export type ResultEntry = Extract<LedgerEntry, { type: "result" }>;

export const resultsOf = (ledger: readonly LedgerEntry[]): ResultEntry[] => ledger.filter((entry): entry is ResultEntry => entry.type === "result");

/** Verified scores rank before self-reported ones; inside each group by score in the metric's direction; agents without a score last. */
export function rankCodeAgents(ledger: readonly LedgerEntry[], direction: Direction): CodeRow[] {
  const workDirs = new Map<number, string>();
  const results = new Map<number, ResultEntry[]>();
  for (const entry of ledger) {
    workDirs.set(entry.agent, entry.workDir);
    if (entry.type === "result") results.set(entry.agent, [...(results.get(entry.agent) ?? []), entry]);
  }
  const rows = [...workDirs].map(([agent, workDir]) => rowFor(agent, workDir, results.get(agent) ?? [], direction));
  rows.sort((a, b) => compare(a, b, direction));
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function rowFor(agent: number, workDir: string, results: ResultEntry[], direction: Direction): CodeRow {
  const scored = results.filter((entry) => entry.status === "ok" && entry.score !== null);
  const verified = scored.filter((entry) => !entry.selfReported);
  const pool = verified.length > 0 ? verified : scored;
  let best: ResultEntry | undefined;
  for (const entry of pool) if (best === undefined || better(entry.score as number, best.score as number, direction)) best = entry;
  return {
    rank: 0,
    agent,
    score: best?.score ?? null,
    selfReported: best?.selfReported ?? false,
    submits: results.length,
    errors: results.filter((entry) => entry.status === "error").length,
    commit: best?.commit ?? null,
    workDir,
  };
}

function compare(a: CodeRow, b: CodeRow, direction: Direction): number {
  if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
  if (a.selfReported !== b.selfReported) return a.selfReported ? 1 : -1;
  if (a.score !== null && b.score !== null && a.score !== b.score) return better(a.score, b.score, direction) ? -1 : 1;
  return a.agent - b.agent;
}

const CSV_HEADER = ["rank", "agent", "score", "self_reported", "submits", "errors", "commit", "work_dir"];

export function renderCodeCsv(rows: readonly CodeRow[]): string {
  return renderCsv(
    CSV_HEADER,
    rows.map((row) => [row.rank, row.agent, row.score, row.selfReported, row.submits, row.errors, row.commit, row.workDir]),
  );
}
