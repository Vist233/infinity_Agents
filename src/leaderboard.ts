import type { LedgerEntry } from "./records.ts";

export interface LeaderboardRow {
  rank: number;
  agent: number;
  proved: boolean;
  steps: number | null;
  elapsedMs: number | null;
  submits: number;
  commit: string | null;
  workDir: string;
}

type Submit = Extract<LedgerEntry, { type: "submit" }>;

/** Math ranking: proved first, then fewest steps, then least time. An agent that never submitted ranks last. */
export function rankAgents(ledger: readonly LedgerEntry[]): LeaderboardRow[] {
  const submitsByAgent = new Map<number, Submit[]>();
  const workDirs = new Map<number, string>();
  for (const entry of ledger) {
    workDirs.set(entry.agent, entry.workDir);
    if (entry.type === "submit") submitsByAgent.set(entry.agent, [...(submitsByAgent.get(entry.agent) ?? []), entry]);
  }
  const rows = [...workDirs].map(([agent, workDir]) => rowFor(agent, workDir, submitsByAgent.get(agent) ?? []));
  rows.sort(compareRows);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function rowFor(agent: number, workDir: string, submits: Submit[]): LeaderboardRow {
  const best = [...submits].sort(compareSubmits)[0];
  return {
    rank: 0,
    agent,
    proved: best?.proved ?? false,
    steps: best?.steps ?? null,
    elapsedMs: best?.elapsedMs ?? null,
    submits: submits.length,
    commit: best?.commit ?? null,
    workDir,
  };
}

function compareSubmits(a: Submit, b: Submit): number {
  return Number(b.proved) - Number(a.proved) || a.steps - b.steps || a.elapsedMs - b.elapsedMs;
}

function compareRows(a: LeaderboardRow, b: LeaderboardRow): number {
  return (
    Number(b.proved) - Number(a.proved) ||
    (a.steps ?? Number.POSITIVE_INFINITY) - (b.steps ?? Number.POSITIVE_INFINITY) ||
    (a.elapsedMs ?? Number.POSITIVE_INFINITY) - (b.elapsedMs ?? Number.POSITIVE_INFINITY) ||
    a.agent - b.agent
  );
}

const CSV_HEADER = "rank,agent,proved,steps,elapsed_ms,submits,commit,work_dir";

export function renderLeaderboardCsv(rows: readonly LeaderboardRow[]): string {
  const lines = rows.map((row) =>
    [row.rank, row.agent, row.proved, row.steps ?? "", row.elapsedMs ?? "", row.submits, row.commit ?? "", csvCell(row.workDir)].join(","),
  );
  return `${[CSV_HEADER, ...lines].join("\n")}\n`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
