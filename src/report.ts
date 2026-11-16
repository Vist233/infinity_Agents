import { mkdirSync, writeFileSync } from "node:fs";
import { renderCodeCsv, rankCodeAgents } from "./code-leaderboard.ts";
import { renderCodeReportHtml } from "./code-report.ts";
import { JsonlFile } from "./jsonl.ts";
import { readMachineSamples } from "./machine-summary.ts";
import type { LedgerEntry, RunEvent } from "./records.ts";
import type { RunLayout } from "./run-layout.ts";
import type { Direction } from "./task.ts";

/** Which number ranks, and in which direction. */
export interface Metric {
  name: string;
  direction: Direction;
}

/** Generates `leaderboard.csv` and `report.html` from the two logs. Safe to call at any time, also during a run. */
export function writeReport(layout: RunLayout, metric: Metric): void {
  const ledger = new JsonlFile<LedgerEntry>(layout.ledger).readAll();
  const events = new JsonlFile<RunEvent>(layout.events).readAll();
  mkdirSync(layout.reportDir, { recursive: true });
  const rows = rankCodeAgents(ledger, metric.direction);
  writeFileSync(layout.leaderboardCsv, renderCodeCsv(rows));
  writeFileSync(layout.reportHtml, renderCodeReportHtml(rows, ledger, events, metric, readMachineSamples(layout.machine)));
}

export const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export const formatTime = (ts: number): string => new Date(ts).toISOString().slice(11, 19);

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "<p><em>none</em></p>";
  const head = headers.map((header) => `<th>${header}</th>`).join("");
  const body = rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The first and last lines of every summary: the task, and how the run ended (or that it has not). */
export function summaryLines(events: readonly RunEvent[]): { task: string; ended: string } {
  const end = events.findLast((event) => event.type === "run_start" || event.type === "run_end");
  const start = events.find((event): event is Extract<RunEvent, { type: "run_start" }> => event.type === "run_start");
  return {
    task: `Task: ${escapeHtml(start?.task ?? "unknown")}`,
    ended:
      end?.type === "run_end"
        ? `Ended: ${escapeHtml(end.reason)} at ${formatTime(end.ts)}, ${end.tokensUsed} tokens used`
        : "Still running (no end recorded yet)",
  };
}

export const summaryHtml = (lines: string[]): string => `<h2>Summary</h2><ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>`;

export function ladderSection(events: readonly RunEvent[]): string {
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

export function pressureSection(events: readonly RunEvent[]): string {
  const rows: string[][] = [];
  for (const event of events) {
    if (event.type === "throttle") rows.push([formatTime(event.ts), "pause for everybody", `${event.delayMs} ms`]);
    if (event.type === "quota") rows.push([formatTime(event.ts), "stop", escapeHtml(event.message)]);
    if (event.type === "budget_refused") rows.push([formatTime(event.ts), "budget stop", escapeHtml(event.reason)]);
    if (event.type === "pressure_hold")
      rows.push([
        formatTime(event.ts),
        event.on ? "pressure brake ON (no climb, no replacements)" : "pressure brake off",
        `rung ${event.rung}, load per core ${event.loadPerCore.toFixed(2)}, CPU pressure ${event.cpuPressure10 ?? "-"} %`,
      ]);
    if (event.type === "rescue") rows.push([formatTime(event.ts), `rescue ${event.rescue} of agent ${event.agent}`, "stuck"]);
  }
  return `<h2>Throttles, stops and rescues</h2>${table(["time", "what", "detail"], rows)}`;
}

/** Warnings of the start (no review, hidden data not protected, ...), shown first so they cannot be missed. */
export function warningSection(events: readonly RunEvent[]): string {
  const warnings = events.filter((event): event is Extract<RunEvent, { type: "warning" }> => event.type === "warning");
  if (warnings.length === 0) return "";
  return `<h2>Warnings</h2><ul>${warnings.map((event) => `<li><strong>${escapeHtml(event.message)}</strong></li>`).join("")}</ul>`;
}

export const pageHtml = (body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Infinity Agent report</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem}table{border-collapse:collapse;width:100%;margin:.5rem 0}
th,td{border:1px solid #ccc;padding:.25rem .5rem;text-align:left}pre{background:#f4f4f4;padding:.75rem;overflow:auto}code{font-family:ui-monospace,monospace}</style></head>
<body><h1>Infinity Agent report</h1>${body}</body></html>
`;
