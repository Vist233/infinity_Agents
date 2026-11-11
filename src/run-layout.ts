import { join, resolve } from "node:path";

/** Where everything of one run lives. The only place that knows the directory layout of docs/02. */
export interface RunLayout {
  root: string;
  ledger: string;
  events: string;
  state: string;
  reportDir: string;
  leaderboardCsv: string;
  reportHtml: string;
  leanDir: string;
  /** Read-only data shared by all agents (code mode `files`), linked into the work directories. */
  sharedDir: string;
  /** The keeper's private directory (hidden data and its journal). Outside every agent's work directory. */
  keeperDir: string;
  /** Forked conversations of the branch review; deleted after each review and swept at the start of a run. */
  reviewDir: string;
  /** One line every few seconds: the machine (load, CPU, memory) and the rung at that time. */
  machine: string;
  agentDir(agent: number): string;
  workDir(agent: number): string;
  sessionFile(agent: number): string;
  /** Written by the orchestrator, outside the agent's confined work directory. */
  provedMarker(agent: number): string;
  /** Written by the orchestrator when the run ends (code mode); the goal of every code agent is `test -f ../finished`. */
  finishedMarker(agent: number): string;
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
    sharedDir: join(root, "shared"),
    keeperDir: join(root, ".keeper"),
    reviewDir: join(root, "reviews"),
    machine: join(root, "machine.jsonl"),
    agentDir,
    workDir: (agent) => join(agentDir(agent), "work"),
    sessionFile: (agent) => join(agentDir(agent), "session.jsonl"),
    provedMarker: (agent) => join(agentDir(agent), "proved"),
    finishedMarker: (agent) => join(agentDir(agent), "finished"),
  };
}
