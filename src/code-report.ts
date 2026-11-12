import { type CodeRow, type ResultEntry, resultsOf } from "./code-leaderboard.ts";
import { recommendCapacity } from "./capacity.ts";
import { type MachineSample, historyFromSamples, summarizeByRung } from "./machine-summary.ts";
import type { LedgerEntry, RunEvent } from "./records.ts";
import { escapeHtml, formatTime, ladderSection, pageHtml, pressureSection, summaryHtml, summaryLines, table, warningSection } from "./report.ts";
import type { Direction } from "./task.ts";

interface Metric {
  name: string;
  direction: Direction;
}

export function renderCodeReportHtml(
  rows: readonly CodeRow[],
  ledger: readonly LedgerEntry[],
  events: readonly RunEvent[],
  metric: Metric,
  machine: readonly MachineSample[] = [],
): string {
  const results = resultsOf(ledger);
  return pageHtml(
    [
      warningSection(events),
      summary(rows, events, results, metric),
      leaderboard(rows, metric),
      scoreChart(results, events, metric),
      resultList(results, metric),
      reviewSection(events),
      ladderSection(events),
      machineSection(machine),
      pressureSection(events),
    ].join("\n"),
  );
}

function summary(rows: readonly CodeRow[], events: readonly RunEvent[], results: readonly ResultEntry[], metric: Metric): string {
  const { task, ended } = summaryLines(events);
  const scored = results.filter((entry) => entry.status === "ok" && !entry.selfReported).length;
  const best = rows.find((row) => row.score !== null);
  const leftover = events.findLast((event): event is Extract<RunEvent, { type: "leftover_processes" }> => event.type === "leftover_processes");
  const gates = (["cpu", "gpu"] as const).flatMap((kind) => {
    const found = events.findLast((event): event is Extract<RunEvent, { type: "slot_summary" }> => event.type === "slot_summary" && event.kind === kind);
    return found ? [found] : [];
  });
  return summaryHtml([
    task,
    `Agents seen: ${rows.length}; submits: ${results.length} (${scored} scored by the evaluator, ${results.filter((entry) => entry.selfReported).length} self-reported, ${results.filter((entry) => entry.status === "error").length} with an error)`,
    best
      ? `Best ${escapeHtml(metric.name)} (${metric.direction === "max" ? "higher" : "lower"} is better): ${best.score}${best.selfReported ? " (self-reported)" : ""} by agent ${best.agent}`
      : "No scored result yet",
    ended,
    ...gates.map(
      (gate) =>
        `Slot gate, ${gate.kind.toUpperCase()} (${gate.slots} slots): ${gate.commands} ${gate.kind === "gpu" ? "GPU jobs" : "heavy commands"}, ${gate.waited} waited a second or more, ` +
        `${Math.round(gate.totalWaitMs / 1000)} s waiting in all, longest ${Math.round(gate.maxWaitMs / 1000)} s; slots busy ${Math.round(100 * gate.utilisation)} % of the time`,
    ),
    ...(leftover ? [`Processes still working in the run directory at the end: ${leftover.found} stopped (${leftover.killedHard} needed SIGKILL)`] : []),
  ]);
}

function leaderboard(rows: readonly CodeRow[], metric: Metric): string {
  const cells = rows.map((row) => [
    String(row.rank),
    String(row.agent),
    row.score === null ? "-" : `${row.score}${row.selfReported ? " (self-reported)" : ""}`,
    String(row.submits),
    String(row.errors),
    `<code>${escapeHtml(row.commit?.slice(0, 10) ?? "-")}</code>`,
    `<code>${escapeHtml(row.workDir)}</code>`,
  ]);
  return `<h2>Leaderboard</h2>${table(["#", "agent", escapeHtml(metric.name), "submits", "errors", "commit", "work"], cells)}`;
}

const WIDTH = 720;
const HEIGHT = 260;
const PAD = 36;
const COLORS = ["#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e", "#17becf", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22"];

/** Best score so far over time, one line per agent, drawn as inline SVG (no script). */
function scoreChart(results: readonly ResultEntry[], events: readonly RunEvent[], metric: Metric): string {
  const points = results.filter((entry) => entry.status === "ok" && entry.score !== null && !entry.selfReported);
  if (points.length === 0) return "<h2>Score over time</h2><p><em>no scored result yet</em></p>";
  const t0 = events.find((event) => event.type === "run_start")?.ts ?? points[0]?.ts ?? 0;
  const t1 = Math.max(...points.map((entry) => entry.ts), t0 + 1);
  const scores = points.map((entry) => entry.score as number);
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  const x = (ts: number) => PAD + ((ts - t0) / (t1 - t0)) * (WIDTH - 2 * PAD);
  const y = (score: number) => HEIGHT - PAD - (high === low ? 0.5 : (score - low) / (high - low)) * (HEIGHT - 2 * PAD);
  const byAgent = new Map<number, ResultEntry[]>();
  for (const entry of points) byAgent.set(entry.agent, [...(byAgent.get(entry.agent) ?? []), entry]);
  const lines = [...byAgent].map(([agent, entries], index) => {
    let best: number | undefined;
    const path = entries
      .map((entry) => {
        const score = entry.score as number;
        if (best === undefined || (metric.direction === "max" ? score > best : score < best)) best = score;
        return `${x(entry.ts).toFixed(1)},${y(best).toFixed(1)}`;
      })
      .join(" ");
    const color = COLORS[index % COLORS.length];
    return `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${path}"><title>agent ${agent}</title></polyline>`;
  });
  const axis = `<text x="4" y="${PAD}" font-size="11">${high}</text><text x="4" y="${HEIGHT - PAD}" font-size="11">${low}</text><text x="${PAD}" y="${HEIGHT - 8}" font-size="11">${formatTime(t0)}</text><text x="${WIDTH - PAD - 40}" y="${HEIGHT - 8}" font-size="11">${formatTime(t1)}</text>`;
  return `<h2>Score over time</h2><p>Best ${escapeHtml(metric.name)} so far, one line per agent (hover for the agent).</p><svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="100%" role="img">${axis}${lines.join("")}</svg>`;
}

function resultList(results: readonly ResultEntry[], metric: Metric): string {
  const latest = results.slice(-40).reverse();
  const cells = latest.map((entry) => [
    formatTime(entry.ts),
    String(entry.agent),
    entry.status === "ok" ? `${entry.score}${entry.selfReported ? " (self-reported)" : ""}` : `<strong>error</strong>`,
    `<code>${escapeHtml(entry.command.slice(0, 120))}</code>`,
    escapeHtml(entry.details.slice(0, 160)),
  ]);
  return `<h2>Latest submits</h2>${table(["time", "agent", escapeHtml(metric.name), "command", "details"], cells)}`;
}

type ReviewEvent = Extract<RunEvent, { type: "review" }>;

/** Branch reviews: how many, what came of them, what they cost, and every steer next to the time it happened (docs/10 section 1.3). */
function reviewSection(events: readonly RunEvent[]): string {
  const reviews = events.filter((event): event is ReviewEvent => event.type === "review");
  const off = events.find((event): event is Extract<RunEvent, { type: "review_off" }> => event.type === "review_off");
  const skips = events.findLast((event): event is Extract<RunEvent, { type: "review_skips" }> => event.type === "review_skips");
  if (reviews.length === 0 && !off && !skips) return "";
  const count = (outcome: ReviewEvent["outcome"]) => reviews.filter((review) => review.outcome === outcome).length;
  const tokens = reviews.reduce((sum, review) => sum + review.tokens, 0);
  const cached = reviews.reduce((sum, review) => sum + (review.cacheRead ?? 0), 0);
  const lines = [
    `Reviews: ${reviews.length} (${count("ok")} nothing to say, ${count("steer")} advice sent, ${count("error")} failed); ${tokens} tokens (also counted in the total), ${tokens > 0 ? Math.round((100 * cached) / tokens) : 0} % of them served from the provider's cache.`,
    skips
      ? `Skipped checks: ${
          Object.entries(skips.skips)
            .map(([reason, n]) => `${escapeHtml(reason)} ${n}`)
            .join(", ") || "none"
        }.`
      : "",
    off ? `<strong>Switched off at ${formatTime(off.ts)}: ${escapeHtml(off.reason)}</strong>` : "",
  ].filter(Boolean);
  const steers = reviews
    .filter((review) => review.outcome === "steer")
    .map((review) => [formatTime(review.ts), String(review.agent), escapeHtml(review.text ?? "")]);
  return `<h2>Reviews</h2><ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>${table(["time", "agent", "advice sent to the agent"], steers)}`;
}

/** The machine by rung (mean and peak), and the rule-of-thumb agent count. The count is a hint for the next run; nothing applies it. */
function machineSection(samples: readonly MachineSample[]): string {
  if (samples.length === 0) return "";
  const gated = samples.some((sample) => sample.slotsInUse !== null && sample.slotsInUse !== undefined);
  const gpuGated = samples.some((sample) => sample.gpuSlotsInUse !== null && sample.gpuSlotsInUse !== undefined);
  const rows = summarizeByRung(samples).map((row) => [
    String(row.rung),
    String(row.samples),
    `${row.loadMean.toFixed(1)} / ${row.loadPeak.toFixed(1)}`,
    row.cpuMean === null ? "-" : `${Math.round(100 * row.cpuMean)} % / ${Math.round(100 * (row.cpuPeak ?? 0))} %`,
    `${(row.memPeakMb / 1024).toFixed(1)} GB`,
    row.gpuMemPeakMb === null ? "-" : `${(row.gpuMemPeakMb / 1024).toFixed(1)} GB`,
    row.pressureMean === null ? "-" : `${row.pressureMean.toFixed(1)} %`,
    row.runCoresMean === null ? "-" : row.runCoresMean.toFixed(1),
    row.runRssPeakMb === null ? "-" : `${(row.runRssPeakMb / 1024).toFixed(1)} GB`,
    row.jobsMean === null ? "-" : `${row.jobsMean.toFixed(1)} / ${row.jobsPeak}`,
    ...(gated ? [row.slotsUseMean === null ? "-" : `${row.slotsUseMean.toFixed(1)} / ${(row.slotsWaitMean ?? 0).toFixed(1)}`] : []),
    ...(gpuGated ? [row.gpuSlotsUseMean === null ? "-" : `${row.gpuSlotsUseMean.toFixed(1)} / ${(row.gpuSlotsWaitMean ?? 0).toFixed(1)}`] : []),
  ]);
  const first = samples[0] as MachineSample;
  const history = historyFromSamples(samples);
  const hint = recommendCapacity({ cores: first.cores, freeMemMb: first.memAvailableMb }, undefined, history);
  const basis = hint.source === "history" ? `measured in this run, limited by ${hint.limitedBy}` : "one per core: this run recorded no per-agent figures";
  const note = `<p>Rule of thumb for the next run (not applied by anything): ${hint.agents} agents (${basis}; more than ${hint.maxUseful} adds little).</p>`;
  return `<h2>Machine by rung</h2>${table(["rung", "samples", "load (mean / peak)", "CPU busy (mean / peak)", "memory peak", "GPU memory peak", "CPU pressure (mean)", "run CPU cores (mean)", "run memory peak", "python jobs (mean / peak)", ...(gated ? ["gate slots in use / waiting (mean)"] : []), ...(gpuGated ? ["GPU slots in use / waiting (mean)"] : [])], rows)}${note}`;
}
