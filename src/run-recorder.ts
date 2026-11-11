import { mkdirSync } from "node:fs";
import type { Clock } from "./clock.ts";
import { JsonlFile } from "./jsonl.ts";
import type { LedgerEntry, RunEvent, WithoutTs } from "./records.ts";
import { type ReportKind, writeReport } from "./report.ts";
import type { RunLayout } from "./run-layout.ts";

type LifecycleEvent = Extract<LedgerEntry, { type: "lifecycle" }>["event"];

export interface SubmitRecord {
  code: string;
  proved: boolean;
  reason: string;
  commit: string | null;
  steps: number;
  elapsedMs: number;
}

export type ResultRecord = Omit<Extract<LedgerEntry, { type: "result" }>, "type" | "ts" | "agent" | "workDir">;

/**
 * Everything the run writes down, behind a few verbs. It knows each agent's last commit, so that every ledger line carries the pointer
 * (agent, workDir, commit) without the caller repeating it.
 */
export class RunRecorder {
  private readonly layout: RunLayout;
  private readonly kind: ReportKind;
  private readonly clock: Clock;
  private readonly ledger: JsonlFile<LedgerEntry>;
  private readonly events: JsonlFile<RunEvent>;
  private readonly lastCommit = new Map<number, string>();

  constructor(layout: RunLayout, clock: Clock, kind: ReportKind = { mode: "math" }) {
    this.kind = kind;
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

  submit(agent: number, record: SubmitRecord): void {
    if (record.commit) this.lastCommit.set(agent, record.commit);
    this.ledger.append({ type: "submit", ...this.pointer(agent), ...record });
  }

  result(agent: number, record: ResultRecord): void {
    if (record.commit) this.lastCommit.set(agent, record.commit);
    this.ledger.append({ type: "result", ...this.pointer(agent), ...record });
  }

  /** Regenerates leaderboard.csv and report.html from the two logs. */
  report(): void {
    writeReport(this.layout, this.kind);
  }

  private pointer(agent: number) {
    return { ts: this.clock.now(), agent, workDir: this.layout.workDir(agent), commit: this.lastCommit.get(agent) || null };
  }
}
