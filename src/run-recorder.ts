import { mkdirSync } from "node:fs";
import type { Clock } from "./clock.ts";
import { JsonlFile } from "./jsonl.ts";
import type { LedgerEntry, RunEvent, WithoutTs } from "./records.ts";
import { type Metric, writeReport } from "./report.ts";
import type { RunLayout } from "./run-layout.ts";

const REPORT_EVERY_MS = 60_000;

type LifecycleEvent = Extract<LedgerEntry, { type: "lifecycle" }>["event"];

export type ResultRecord = Omit<Extract<LedgerEntry, { type: "result" }>, "type" | "ts" | "agent" | "workDir">;

/**
 * Everything the run writes down, behind a few verbs. It knows each agent's last commit, so that every ledger line carries the pointer
 * (agent, workDir, commit) without the caller repeating it.
 */
export class RunRecorder {
  private readonly layout: RunLayout;
  private readonly metric: Metric;
  private readonly clock: Clock;
  private readonly ledger: JsonlFile<LedgerEntry>;
  private readonly events: JsonlFile<RunEvent>;
  private readonly lastCommit = new Map<number, string>();
  private lastReportAt = Number.NEGATIVE_INFINITY;

  constructor(layout: RunLayout, clock: Clock, metric: Metric) {
    this.metric = metric;
    this.layout = layout;
    this.clock = clock;
    mkdirSync(layout.root, { recursive: true });
    this.ledger = new JsonlFile<LedgerEntry>(layout.ledger);
    this.events = new JsonlFile<RunEvent>(layout.events);
  }

  event(event: WithoutTs<RunEvent>): void {
    this.events.append({ ...event, ts: this.clock.now() } as RunEvent);
  }

  lifecycle(agent: number, event: LifecycleEvent, detail = ""): void {
    this.ledger.append({ type: "lifecycle", ...this.pointer(agent), event, detail });
  }

  commit(agent: number, commit: string, turn: number): void {
    this.lastCommit.set(agent, commit);
    this.ledger.append({ type: "commit", ...this.pointer(agent), commit, turn });
  }

  result(agent: number, record: ResultRecord): void {
    if (record.commit) this.lastCommit.set(agent, record.commit);
    this.ledger.append({ type: "result", ...this.pointer(agent), ...record });
    // the files in report/ are snapshots; after a result they are rewritten at most once a minute (the viewer ranks from the ledger itself)
    if (this.clock.now() - this.lastReportAt >= REPORT_EVERY_MS) this.report();
  }

  /** Regenerates leaderboard.csv and report.html from the two logs. */
  report(): void {
    this.lastReportAt = this.clock.now();
    writeReport(this.layout, this.metric);
  }

  private pointer(agent: number) {
    return { ts: this.clock.now(), agent, workDir: this.layout.workDir(agent), commit: this.lastCommit.get(agent) || null };
  }
}
