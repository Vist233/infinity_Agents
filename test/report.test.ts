import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankCodeAgents } from "../src/code-leaderboard.ts";
import { renderCodeReportHtml } from "../src/code-report.ts";
import { JsonlFile } from "../src/jsonl.ts";
import type { LedgerEntry, RunEvent } from "../src/records.ts";
import { writeReport } from "../src/report.ts";
import { runLayout } from "../src/run-layout.ts";

const PROOF = { name: "proved", direction: "max" } as const;

/** One scored submit; a proof task writes score 1 for an accepted proof and 0 for a rejected one. */
const result = (agent: number, score: number, extra: Partial<Extract<LedgerEntry, { type: "result" }>> = {}): LedgerEntry => ({
  type: "result",
  ts: 1_000,
  agent,
  workDir: `w/${agent}`,
  commit: `c${agent}`,
  command: "lean submit Proof.lean",
  entry: `proof ${agent}`,
  files: ["Proof.lean"],
  status: "ok",
  score,
  metrics: {},
  details: score === 1 ? "accepted" : "bad",
  selfReported: false,
  steps: 3,
  elapsedMs: 10,
  ...extra,
});
const started = (agent: number): LedgerEntry => ({ type: "lifecycle", ts: 1, agent, workDir: `w/${agent}`, commit: null, event: "started", detail: "" });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-report-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("JsonlFile", () => {
  it("reads nothing from a file that does not exist", () => {
    expect(new JsonlFile(join(root, "none.jsonl")).readAll()).toEqual([]);
  });
  it("appends lines and reads them back in order", () => {
    const file = new JsonlFile<{ n: number }>(join(root, "a.jsonl"));
    file.append({ n: 1 });
    file.append({ n: 2 });
    expect(file.readAll()).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("skips a torn last line", () => {
    const file = new JsonlFile<{ n: number }>(join(root, "a.jsonl"));
    file.append({ n: 1 });
    appendFileSync(file.path, '{"n": 2');
    expect(file.readAll()).toEqual([{ n: 1 }]);
  });
});

describe("report.html of a proof task", () => {
  const events: RunEvent[] = [
    { type: "run_start", ts: 0, task: "parity <test>", ceiling: 4, resumed: false },
    { type: "rung", ts: 5_000, from: 1, to: 2, reason: "advance", replies: 3, throttles: 0, latencyP50Ms: 800, latencyP95Ms: 1200, tokensPerMinute: 4000 },
    { type: "rung", ts: 9_000, from: 4, to: 2, reason: "throttle", replies: 12, throttles: 2, latencyP50Ms: 900, latencyP95Ms: 2000, tokensPerMinute: 9000 },
    { type: "throttle", ts: 8_000, delayMs: 2500 },
    { type: "rescue", ts: 9_500, agent: 3, rescue: 1 },
    { type: "budget_refused", ts: 9_600, reason: "token budget reached" },
    { type: "quota", ts: 9_700, message: "no balance" },
    { type: "run_end", ts: 10_000, reason: "target", tokensUsed: 4242, bestScore: 1 },
  ];
  const ledger = [started(1), result(1, 0, { details: "unsolved goals <x>" }), result(2, 1)];
  const html = renderCodeReportHtml(rankCodeAgents(ledger, "max"), ledger, events, PROOF);

  it("shows the summary with the outcome and the tokens", () => {
    expect(html).toContain("Ended: target");
    expect(html).toContain("4242 tokens");
    expect(html).toContain("Best proved (higher is better): 1 by agent 2");
  });
  it("shows the leaderboard and the best submit, the proof itself", () => {
    expect(html).toContain("<pre>proof 2</pre>");
    expect(html).toContain("unsolved goals &lt;x&gt;");
  });
  it("shows the ladder with the throttle that found the limit", () => {
    expect(html).toContain("1 → 2");
    expect(html).toContain("4 → 2");
    expect(html).toContain("throttled (provider limit)");
    expect(html).toContain("800 / 1200 ms");
  });
  it("shows throttles, rescues, budget and quota stops", () => {
    for (const text of ["pause for everybody", "2500 ms", "rescue 1 of agent 3", "budget stop", "no balance"]) expect(html).toContain(text);
  });
  it("escapes what the agents and the task wrote", () => {
    expect(html).toContain("parity &lt;test&gt;");
    expect(html).not.toContain("<test>");
  });
  it("says so when a run is still going and nothing is scored", () => {
    const early = renderCodeReportHtml([], [], [], PROOF);
    expect(early).toContain("Still running");
    expect(early).toContain("No scored result yet");
  });
});

describe("writeReport", () => {
  it("writes both files from the two logs of a run", () => {
    const layout = runLayout(root);
    new JsonlFile<LedgerEntry>(layout.ledger).append(result(1, 1));
    new JsonlFile<RunEvent>(layout.events).append({ type: "run_end", ts: 1, reason: "target", tokensUsed: 10, bestScore: 1 });
    writeReport(layout, PROOF);
    expect(readFileSync(layout.leaderboardCsv, "utf8")).toContain("1,1,1,false,1,0,c1");
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("Ended: target");
  });
});

describe("runLayout", () => {
  it("keeps the finished marker next to, not inside, the work directory", () => {
    const layout = runLayout("/r");
    expect(layout.workDir(7)).toBe("/r/agents/007/work");
    expect(layout.finishedMarker(7)).toBe("/r/agents/007/finished");
    expect(layout.sessionFile(7)).toBe("/r/agents/007/session.jsonl");
  });
});

describe("runLayout with a relative root", () => {
  it("makes every path absolute, so that other working directories see the same place (a real run failed on this)", () => {
    const layout = runLayout("runs/relative");
    for (const path of [layout.root, layout.leanDir, layout.workDir(1), layout.finishedMarker(1), layout.sessionFile(1), layout.ledger])
      expect(path.startsWith("/")).toBe(true);
  });
});
