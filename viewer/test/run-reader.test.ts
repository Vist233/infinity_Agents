import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRunDir, listRuns, normalizeMachine, parseCsv, RunReader } from "../run-reader.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const x100 = join(fixtures, "x100", "runs", "covertype-2026-11-11T14-36-50-298Z");
const x3 = join(fixtures, "x3", "runs", "covertype-2026-11-11T09-12-58-837Z");
const synthetic = join(fixtures, "synthetic");

const temps: string[] = [];
function tempRun(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "viewer-test-"));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const line = (o: object) => `${JSON.stringify(o)}\n`;

describe.skipIf(!isRunDir(x100))("the archived 100-agent run", () => {
  const reader = new RunReader(x100);
  reader.poll();
  const summary = reader.summary();

  it("counts agents, submits, reviews and refusals", () => {
    expect(summary.task).toBe("covertype");
    expect(summary.state).toBe("finished");
    expect(summary.endReason).toBe("budget");
    expect(summary.agentsStarted).toBe(100);
    expect(summary.agentsLive).toBe(0);
    expect(summary.submits).toBe(8);
    expect(summary.scoredSubmits).toBe(8);
    expect(summary.reviews).toBe(12);
    expect(summary.refusals).toBe(10);
    expect(summary.tokensUsed).toBe(39737844);
  });

  it("finds the best score, the rungs and the leaderboard", () => {
    expect(summary.bestScore).toBe(0.9774);
    expect(summary.rungs).toEqual([1, 2, 4, 8, 16, 32, 64, 100]);
    expect(summary.rung).toBe(100);
    expect(summary.leaderboard[0]).toMatchObject({ rank: 1, agent: 8, score: 0.9774 });
    expect(summary.leaderboard).toHaveLength(100);
    const series = reader.series();
    expect(series.rungs.map((r) => r.to)).toEqual([2, 4, 8, 16, 32, 64, 100]);
    expect(series.initialRung).toBe(1);
    expect(Math.max(...series.agentsLive.map((p) => p[1]))).toBe(100);
    expect(series.agentsLive.at(-1)?.[1]).toBe(0);
  });

  it("builds the agents table", () => {
    const rows = reader.agentRows();
    expect(rows).toHaveLength(100);
    const four = rows.find((r) => r.agent === 4);
    expect(four).toMatchObject({ submits: 3, bestScore: 0.9678 });
    expect(rows.find((r) => r.agent === 8)?.bestScore).toBe(0.9774);
    expect(rows.every((r) => r.startedAt !== null && r.endedAt !== null)).toBe(true);
    expect(rows[65]?.endDetail).toContain("retire");
  });

  it("finds the old machine file next to the runs directory; readings start at minute 29", () => {
    expect(summary.machineSamples).toBe(168);
    const first = reader.series().machine[0];
    expect(first).toBeDefined();
    const minute = ((first?.ts ?? 0) - (summary.startedAt ?? 0)) / 60000;
    expect(minute).toBeGreaterThan(28.5);
    expect(minute).toBeLessThan(29.5);
    expect(first).toMatchObject({ cores: 16, load1: 600.72, agents: 64, slotsInUse: null });
    expect(first?.loadPerCore).toBeCloseTo(37.545, 2);
  });

  it("thins the machine series on request but keeps the last reading", () => {
    const thin = reader.series(20).machine;
    expect(thin.length).toBeLessThan(40);
    expect(thin.at(-1)?.ts).toBe(reader.series().machine.at(-1)?.ts);
  });
});

describe.skipIf(!isRunDir(x3))("the archived 3-agent run", () => {
  it("has no machine readings and counts its agents", () => {
    const reader = new RunReader(x3);
    reader.poll();
    const s = reader.summary();
    expect(s.agentsStarted).toBe(4); // the ledger shows four started agents (a fourth was started in the run)
    expect(s.machineSamples).toBe(0);
    expect(s.state).toBe("finished");
    expect(reader.series().machine).toEqual([]);
  });
});

describe("the synthetic run with the new machine fields", () => {
  const reader = new RunReader(synthetic);
  reader.poll();
  it("reads flat machine readings, slots and run facts", () => {
    const s = reader.summary();
    expect(s.machineSamples).toBe(48);
    expect(s.facts?.cores).toBe(16);
    expect(s.ceiling).toBe(8);
    expect(s.bestScore).toBeNull();
    const machine = reader.series().machine;
    expect(machine.some((m) => m.slotsInUse !== null && m.slotsInUse > 0)).toBe(true);
    expect(machine[0]).toMatchObject({ cores: 16, load1: 0.66, rung: 1, agents: 1 });
    expect(machine.at(-1)?.runCpuCores).not.toBeUndefined();
  });
});

describe("tolerance", () => {
  it("accepts an empty directory", () => {
    const reader = new RunReader(tempRun());
    expect(reader.poll()).toBe(false);
    expect(reader.summary().state).toBe("empty");
    expect(reader.agentRows()).toEqual([]);
  });

  it("leaves a half-written last line for later and takes it once complete", () => {
    const dir = tempRun({ "events.jsonl": `${line({ type: "run_start", ts: 1000, task: "t", ceiling: 4, resumed: false })}{"type":"warning","mess` });
    const reader = new RunReader(dir, { now: () => 2000 });
    reader.poll();
    expect(reader.summary().warnings).toEqual([]);
    expect(reader.eventList()).toHaveLength(1);
    appendFileSync(join(dir, "events.jsonl"), `age":"half","ts":1500}\n`);
    reader.poll();
    expect(reader.summary().warnings).toEqual(["half"]);
  });

  it("takes a complete last line that has no newline yet, once", () => {
    const dir = tempRun({
      "events.jsonl": `${line({ type: "run_start", ts: 1000, task: "t", ceiling: 4, resumed: false })}${JSON.stringify({ type: "warning", message: "w", ts: 1100 })}`,
    });
    const reader = new RunReader(dir);
    reader.poll();
    reader.poll();
    expect(reader.eventList()).toHaveLength(2);
    appendFileSync(join(dir, "events.jsonl"), "\n");
    reader.poll();
    expect(reader.eventList()).toHaveLength(2);
  });

  it("skips garbage lines and keeps unknown event types without failing", () => {
    const dir = tempRun({
      "events.jsonl": `${line({ type: "run_start", ts: 1000, task: "t", ceiling: 4, resumed: false })}not json\n\n[1,2]\n${line({ type: "future_thing", ts: 1200, note: "x", nested: { a: 1 } })}${line({ ts: 5 })}`,
      "ledger.jsonl": `${line({ type: "lifecycle", ts: 1001, agent: 1, event: "started" })}${line({ type: "result", ts: 1100, agent: 1 })}${line({ type: "mystery", ts: 1100, agent: 1 })}`,
    });
    const reader = new RunReader(dir, { now: () => 1300 });
    reader.poll();
    expect(reader.eventList().map((e) => e.type)).toEqual(["run_start", "future_thing"]);
    const row = reader.agentRows()[0];
    expect(row).toMatchObject({ agent: 1, submits: 1, bestScore: null });
    expect(reader.summary().scoredSubmits).toBe(0);
    expect(reader.summary().state).toBe("running");
  });

  it("calls a run without end record and without activity stopped", () => {
    const dir = tempRun({ "events.jsonl": line({ type: "run_start", ts: 1000, task: "t", ceiling: 4, resumed: false }) });
    const reader = new RunReader(dir, { now: () => 1000 + 10 * 60_000 });
    reader.poll();
    expect(reader.summary().state).toBe("stopped");
  });

  it("works with a damaged state.json and a leaderboard with quoted cells", () => {
    const dir = tempRun({ "state.json": "{broken", "events.jsonl": line({ type: "run_start", ts: 1, task: "t", ceiling: 1, resumed: false }) });
    mkdirSync(join(dir, "report"));
    writeFileSync(join(dir, "report", "leaderboard.csv"), 'rank,agent,score,self_reported,submits,errors,commit,work_dir\n1,2,0.5,true,3,1,abc,"/a,b"\n');
    const reader = new RunReader(dir);
    reader.poll();
    expect(reader.summary().leaderboard).toEqual([{ rank: 1, agent: 2, score: 0.5, selfReported: true, submits: 3, errors: 1 }]);
  });
});

describe("incremental reading", () => {
  it("reads the current live state and cumulative scores after a resume", () => {
    const dir = tempRun({
      "events.jsonl": [
        { type: "run_start", ts: 10, task: "loss" },
        { type: "run_end", ts: 20, reason: "stopped", tokensUsed: 20 },
      ]
        .map(line)
        .join(""),
      "ledger.jsonl": [
        { type: "lifecycle", ts: 11, agent: 1, event: "started" },
        { type: "result", ts: 12, agent: 1, score: 0.8, status: "ok" },
        { type: "lifecycle", ts: 19, agent: 1, event: "ended" },
      ]
        .map(line)
        .join(""),
      "state.json": JSON.stringify({ finished: "stopped" }),
    });
    const reader = new RunReader(dir, { now: () => 40 });
    reader.poll();
    expect(reader.summary()).toMatchObject({ state: "finished", tokensUsed: 20 });
    appendFileSync(join(dir, "events.jsonl"), line({ type: "run_start", ts: 30, task: "loss", resumed: true, metricDirection: "min" }));
    appendFileSync(
      join(dir, "ledger.jsonl"),
      line({ type: "lifecycle", ts: 31, agent: 1, event: "started" }) + line({ type: "result", ts: 32, agent: 1, score: 0.3, status: "ok" }),
    );
    writeFileSync(join(dir, "state.json"), JSON.stringify({ finished: null, tokensUsed: 50 }));
    reader.poll();
    expect(reader.summary()).toMatchObject({ state: "running", agentsLive: 1, agentsStarted: 1, tokensUsed: 50, bestScore: 0.3, metricDirection: "min" });
    expect(reader.agentRows()[0]).toMatchObject({ endedAt: null, bestScore: 0.3 });
  });
  it("reads only new lines when the files grow and reports changes", () => {
    const dir = tempRun({
      "events.jsonl": line({ type: "run_start", ts: 1000, task: "t", ceiling: 4, resumed: false }),
      "ledger.jsonl": line({ type: "lifecycle", ts: 1001, agent: 1, event: "started", detail: "" }),
      "machine.jsonl": line({ ts: 1002, cores: 4, load1: 2, cpuBusy: 0.5 }),
    });
    const reader = new RunReader(dir, { now: () => 2000 });
    expect(reader.poll()).toBe(true);
    expect(reader.poll()).toBe(false);
    expect(reader.summary().agentsLive).toBe(1);

    appendFileSync(
      join(dir, "ledger.jsonl"),
      line({ type: "result", ts: 1500, agent: 1, status: "ok", score: 0.7, selfReported: false }) + line({ type: "commit", ts: 1600, agent: 1 }),
    );
    appendFileSync(join(dir, "events.jsonl"), line({ type: "rung", ts: 1700, from: 1, to: 2, reason: "advance" }));
    appendFileSync(join(dir, "machine.jsonl"), line({ ts: 1800, cores: 4, load1: 4, cpuBusy: 0.9 }));
    expect(reader.poll()).toBe(true);
    const s = reader.summary();
    expect(s.scoredSubmits).toBe(1);
    expect(s.bestScore).toBe(0.7);
    expect(s.rung).toBe(2);
    expect(s.machineSamples).toBe(2);
    expect(reader.agentRows()[0]).toMatchObject({ commits: 1, submits: 1, bestScore: 0.7 });
    expect(reader.poll()).toBe(false);
  });

  it("accepts multi-byte text split across reads", () => {
    const dir = tempRun({ "events.jsonl": line({ type: "run_start", ts: 1, task: "t", ceiling: 1, resumed: false }) });
    const reader = new RunReader(dir);
    reader.poll();
    const full = Buffer.from(line({ type: "warning", ts: 2, message: "größe ✓" }));
    appendFileSync(join(dir, "events.jsonl"), full.subarray(0, 40));
    reader.poll();
    appendFileSync(join(dir, "events.jsonl"), full.subarray(40));
    reader.poll();
    expect(reader.summary().warnings).toEqual(["größe ✓"]);
  });
});

describe("helpers", () => {
  it("normalises flat and nested machine records and rejects records without a time", () => {
    expect(normalizeMachine({ ts: 1, cores: 8, load1: 4, memUsedMb: 10, gpuUtilPercent: 5, agents: 3 })).toMatchObject({
      loadPerCore: 0.5,
      memUsedMb: 10,
      gpuUtil: 5,
      agents: 3,
    });
    expect(
      normalizeMachine({
        ts: 1,
        cores: 8,
        load: { one: 8 },
        memory: { usedMb: 7, totalMb: 9 },
        gpu: { utilPercent: 1, memoryUsedMb: 2 },
        run: { agentsLive: 4 },
      }),
    ).toMatchObject({
      loadPerCore: 1,
      memUsedMb: 7,
      memTotalMb: 9,
      gpuUtil: 1,
      gpuMemMb: 2,
      agents: 4,
    });
    expect(normalizeMachine({ cores: 8 })).toBeNull();
    expect(normalizeMachine("x")).toBeNull();
    expect(normalizeMachine({ ts: 1, cpuBusy: "high" })?.cpuBusy).toBeNull();
  });

  it("parses CSV with quotes and a missing final newline", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\r\n1,2')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", "2"],
    ]);
  });

  it("recognises and lists run directories", () => {
    expect(isRunDir(synthetic)).toBe(true);
    expect(isRunDir(fixtures)).toBe(false);
    expect(listRuns(fixtures).map((r) => r.name)).toContain("synthetic");
  });
});
