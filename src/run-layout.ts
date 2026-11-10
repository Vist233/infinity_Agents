import { join, resolve } from "node:path";

/** Where everything of one run lives. The only place that knows the directory layout of a run. */
export interface RunLayout {
  root: string;
  ledger: string;
  events: string;
  state: string;
  reportDir: string;
  leaderboardCsv: string;
  reportHtml: string;
  leanDir: string;
  agentDir(agent: number): string;
  workDir(agent: number): string;
  sessionFile(agent: number): string;
  /** Written by the orchestrator, outside the agent's confined work directory. */
  provedMarker(agent: number): string;
}

const agentName = (agent: number) => String(agent).padStart(3, "0");

/** The root becomes an absolute path: Lean runs in other directories and needs paths that mean the same everywhere. */
export function runLayout(rootPath: string): RunLayout {
  const root = resolve(rootPath);
  const agentDir = (agent: number) => join(root, "agents", agentName(agent));
  return {
    root,
    ledger: join(root, "ledger.jsonl"),
    events: join(root, "events.jsonl"),
    state: join(root, "state.json"),
    reportDir: join(root, "report"),
    leaderboardCsv: join(root, "report", "leaderboard.csv"),
    reportHtml: join(root, "report", "report.html"),
    leanDir: join(root, "lean"),
    agentDir,
    workDir: (agent) => join(agentDir(agent), "work"),
    sessionFile: (agent) => join(agentDir(agent), "session.jsonl"),
    provedMarker: (agent) => join(agentDir(agent), "proved"),
  };
}
