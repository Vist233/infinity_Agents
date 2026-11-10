import { mkdirSync, writeFileSync } from "node:fs";
import { JsonlFile } from "./jsonl.ts";
import { type LeaderboardRow, rankAgents, renderLeaderboardCsv } from "./leaderboard.ts";
import type { LedgerEntry, RunEvent } from "./records.ts";
import type { RunLayout } from "./run-layout.ts";

/** Generates `leaderboard.csv` and `report.html` from the two logs. Safe to call at any time, also during a run. */
export function writeReport(layout: RunLayout): void {
  const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
  const events = new JsonlFile<RunEvent>(layout.events).readAll();
  const rows = rankAgents(ledger);
  mkdirSync(layout.reportDir, { recursive: true });
  writeFileSync(layout.leaderboardCsv, renderLeaderboardCsv(rows));
  writeFileSync(layout.reportHtml, renderReportHtml(rows, ledger, events));
}

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const formatTime = (ts: number): string => new Date(ts).toISOString().slice(11, 19);
const formatSeconds = (ms: number | null): string => (ms === null ? "-" : `${(ms / 1000).toFixed(1)} s`);

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "<p><em>none</em></p>";
  const head = headers.map((header) => `<th>${header}</th>`).join("");
  const body = rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderReportHtml(rows: readonly LeaderboardRow[], ledger: readonly LedgerEntry[], events: readonly RunEvent[]): string {
  const sections = [summarySection(rows, events), leaderboardSection(rows), proofSection(ledger), ladderSection(events), pressureSection(events)];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Infinity Agent report</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem}table{border-collapse:collapse;width:100%;margin:.5rem 0}
th,td{border:1px solid #ccc;padding:.25rem .5rem;text-align:left}pre{background:#f4f4f4;padding:.75rem;overflow:auto}code{font-family:ui-monospace,monospace}</style></head>
<body><h1>Infinity Agent report</h1>${sections.join("\n")}</body></html>
`;
}

function summarySection(rows: readonly LeaderboardRow[], events: readonly RunEvent[]): string {
  const end = events.findLast((event): event is Extract<RunEvent, { type: "run_end" }> => event.type === "run_end");
  const start = events.find((event): event is Extract<RunEvent, { type: "run_start" }> => event.type === "run_start");
  const lines = [
    `Task: ${escapeHtml(start?.task ?? "unknown")}`,
    `Agents seen: ${rows.length}, proved: ${rows.filter((row) => row.proved).length}`,
    end ? `Ended: ${escapeHtml(end.reason)} at ${formatTime(end.ts)}, ${end.tokensUsed} tokens used` : "Still running (no end recorded yet)",
  ];
  return `<h2>Summary</h2><ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>`;
}

function leaderboardSection(rows: readonly LeaderboardRow[]): string {
  const cells = rows.map((row) => [
    String(row.rank),
    String(row.agent),
    row.proved ? "proved" : "not proved",
    row.steps === null ? "-" : String(row.steps),
    formatSeconds(row.elapsedMs),
    String(row.submits),
    `<code>${escapeHtml(row.commit?.slice(0, 10) ?? "-")}</code>`,
    `<code>${escapeHtml(row.workDir)}</code>`,
  ]);
  return `<h2>Leaderboard</h2>${table(["#", "agent", "result", "steps", "time", "submits", "commit", "work"], cells)}`;
}

function proofSection(ledger: readonly LedgerEntry[]): string {
  const submits = ledger.filter((entry): entry is Extract<LedgerEntry, { type: "submit" }> => entry.type === "submit");
  const winner = submits.find((entry) => entry.proved);
  const failures = submits.filter((entry) => !entry.proved);
  const winnerHtml = winner
    ? `<p>Agent ${winner.agent} at commit <code>${escapeHtml(winner.commit?.slice(0, 10) ?? "-")}</code>:</p><pre>${escapeHtml(winner.code)}</pre>`
    : "<p><em>no accepted proof</em></p>";
  const failureRows = failures.map((entry) => [String(entry.agent), formatTime(entry.ts), escapeHtml(entry.reason.slice(0, 300))]);
  return `<h2>First accepted proof</h2>${winnerHtml}<h2>Rejected submits</h2>${table(["agent", "time", "reason"], failureRows)}`;
}

function ladderSection(events: readonly RunEvent[]): string {
  const rungs = events.filter((event): event is Extract<RunEvent, { type: "rung" }> => event.type === "rung");
  const cells = rungs.map((rung) => [
    formatTime(rung.ts),
    `${rung.from} → ${rung.to}`,
    rung.reason === "throttle" ? "<strong>throttled (provider limit)</strong>" : "advance",
    String(rung.replies),
    String(rung.throttles),
    `${rung.latencyP50Ms} / ${rung.latencyP95Ms} ms`,
    String(Math.round(rung.tokensPerMinute)),
  ]);
  return `<h2>Ladder</h2>${table(["time", "agents", "why", "replies", "throttles", "latency p50 / p95", "tokens per minute"], cells)}`;
}

function pressureSection(events: readonly RunEvent[]): string {
  const rows: string[][] = [];
  for (const event of events) {
    if (event.type === "throttle") rows.push([formatTime(event.ts), "pause for everybody", `${event.delayMs} ms`]);
    if (event.type === "quota") rows.push([formatTime(event.ts), "stop", escapeHtml(event.message)]);
    if (event.type === "budget_refused") rows.push([formatTime(event.ts), "budget stop", escapeHtml(event.reason)]);
    if (event.type === "rescue") rows.push([formatTime(event.ts), `rescue ${event.rescue} of agent ${event.agent}`, "stuck"]);
  }
  return `<h2>Throttles, stops and rescues</h2>${table(["time", "what", "detail"], rows)}`;
}
