import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFile } from "../src/jsonl.ts";
import { rankAgents, renderLeaderboardCsv } from "../src/leaderboard.ts";
import type { LedgerEntry, RunEvent } from "../src/records.ts";
import { renderReportHtml, writeReport } from "../src/report.ts";
import { runLayout } from "../src/run-layout.ts";

const submit = (agent: number, proved: boolean, steps: number, elapsedMs: number, extra: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({
    type: "submit",
    ts: 1_000,
    agent,
    workDir: `w/${agent}`,
    commit: `c${agent}`,
    code: `proof ${agent}`,
    proved,
    reason: proved ? "proved" : "bad",
    steps,
    elapsedMs,
    ...extra,
  }) as LedgerEntry;
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

describe("rankAgents", () => {
  it("ranks proved before unproved, then fewer steps, then less time", () => {
    const rows = rankAgents([submit(1, false, 2, 10), submit(2, true, 9, 50), submit(3, true, 4, 90), submit(4, true, 4, 60)]);
    expect(rows.map((row) => row.agent)).toEqual([4, 3, 2, 1]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3, 4]);
  });
  it("uses the best submit of an agent and counts all of them", () => {
    const rows = rankAgents([submit(1, false, 2, 10), submit(1, true, 8, 80)]);
    expect(rows[0]).toMatchObject({ agent: 1, proved: true, steps: 8, submits: 2, commit: "c1" });
  });
  it("lists agents that never submitted last, with empty cells", () => {
    const rows = rankAgents([started(7), submit(1, false, 3, 10)]);
    expect(rows.map((row) => row.agent)).toEqual([1, 7]);
    expect(rows[1]).toMatchObject({ proved: false, steps: null, submits: 0 });
  });
  it("is empty for an empty ledger", () => {
    expect(rankAgents([])).toEqual([]);
  });
});

describe("renderLeaderboardCsv", () => {
  it("writes a header and one line per row, quoting cells that need it", () => {
    const rows = rankAgents([submit(1, true, 3, 1500, { workDir: 'dir,with "quote"' } as Partial<LedgerEntry>)]);
    expect(renderLeaderboardCsv(rows)).toBe('rank,agent,proved,steps,elapsed_ms,submits,commit,work_dir\n1,1,true,3,1500,1,c1,"dir,with ""quote"""\n');
  });
});

describe("report.html", () => {
  const events: RunEvent[] = [
    { type: "run_start", ts: 0, task: "parity <test>", ceiling: 4, resumed: false },
    { type: "rung", ts: 5_000, from: 1, to: 2, reason: "advance", replies: 3, throttles: 0, latencyP50Ms: 800, latencyP95Ms: 1200, tokensPerMinute: 4000 },
    { type: "rung", ts: 9_000, from: 4, to: 2, reason: "throttle", replies: 12, throttles: 2, latencyP50Ms: 900, latencyP95Ms: 2000, tokensPerMinute: 9000 },
    { type: "throttle", ts: 8_000, delayMs: 2500 },
    { type: "rescue", ts: 9_500, agent: 3, rescue: 1 },
    { type: "budget_refused", ts: 9_600, reason: "token budget reached" },
    { type: "quota", ts: 9_700, message: "no balance" },
    { type: "run_end", ts: 10_000, reason: "proved", tokensUsed: 4242, proved: [2] },
  ];
  const ledger = [started(1), submit(1, false, 2, 10, { reason: "unsolved goals <x>" } as Partial<LedgerEntry>), submit(2, true, 5, 90)];
  const html = renderReportHtml(rankAgents(ledger), ledger, events);

  it("shows the summary with the outcome and the tokens", () => {
    expect(html).toContain("Ended: proved");
    expect(html).toContain("4242 tokens");
    expect(html).toContain("proved: 1");
  });
  it("shows the leaderboard, the first accepted proof and the rejected submits", () => {
    expect(html).toContain("<pre>proof 2</pre>");
    expect(html).toContain("unsolved goals &lt;x&gt;");
    expect(html.indexOf("<td>2</td><td>proved")).toBeGreaterThan(0);
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
  it("says so when a run is still going and nothing is proved", () => {
    const early = renderReportHtml([], [], []);
    expect(early).toContain("Still running");
    expect(early).toContain("no accepted proof");
  });
});

describe("writeReport", () => {
  it("writes both files from the two logs of a run", () => {
    const layout = runLayout(root);
    new JsonlFile<LedgerEntry>(layout.ledger).append(submit(1, true, 2, 20));
    new JsonlFile<RunEvent>(layout.events).append({ type: "run_end", ts: 1, reason: "proved", tokensUsed: 10, proved: [1] });
    writeReport(layout);
    expect(readFileSync(layout.leaderboardCsv, "utf8")).toContain("1,1,true,2,20,1,c1");
    expect(readFileSync(layout.reportHtml, "utf8")).toContain("Ended: proved");
  });
});

describe("runLayout", () => {
  it("keeps the proved marker next to, not inside, the work directory", () => {
    const layout = runLayout("/r");
    expect(layout.workDir(7)).toBe("/r/agents/007/work");
    expect(layout.provedMarker(7)).toBe("/r/agents/007/proved");
    expect(layout.sessionFile(7)).toBe("/r/agents/007/session.jsonl");
  });
});

describe("runLayout with a relative root", () => {
  it("makes every path absolute, so that other working directories see the same place (a real run failed on this)", () => {
    const layout = runLayout("runs/relative");
    for (const path of [layout.root, layout.leanDir, layout.workDir(1), layout.provedMarker(1), layout.sessionFile(1), layout.ledger])
      expect(path.startsWith("/")).toBe(true);
  });
});
