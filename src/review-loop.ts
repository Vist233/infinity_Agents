import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentWorker } from "./agent-worker.ts";
import type { Clock } from "./clock.ts";
import type { Gate } from "./gate.ts";
import type { RunEvent, WithoutTs } from "./records.ts";
import { type ReviewOutcome, type ReviewTarget, runReview } from "./review-run.ts";
import { ReviewScheduler } from "./review-schedule.ts";
import type { ReviewOutputSettings } from "./review-snapshot.ts";
import type { Budget } from "./budget.ts";
import type { RunLayout } from "./run-layout.ts";
import type { BranchReviewSettings } from "./task.ts";

// ---------------------------------------------------------------- all agents

export interface BranchReviewerOptions {
  everyMs: number;
  ceiling: number;
  maxTurns: number;
  maxConcurrent: number;
  clock: Clock;
  /** Where fork files go. */
  dir: string;
  /** The handle of a live agent, or undefined when it has none (not started yet, or ended). */
  target(agent: number): (ReviewTarget & { workDir: string }) | undefined;
  /** A reason not to start any review now (the Gate is paused, the budget refuses), or undefined. */
  holdReason(): string | undefined;
  onResult(agent: number, outcome: ReviewOutcome): void;
  onOff(reason: string): void;
  output?: ReviewOutputSettings;
  /** For tests: replaces the review itself. */
  review?: typeof runReview;
}

const MAX_ERRORS_IN_A_ROW = 5;

/** Runs the reviews of all agents on their schedule. Failure isolation: an error is reported and ignored; five in a row switch the feature off. */
export class BranchReviewer {
  private readonly options: BranchReviewerOptions;
  private readonly scheduler: ReviewScheduler;
  private readonly running = new Map<number, Promise<void>>();
  private readonly reviewedAt = new Map<number, number>();
  private readonly stopSignal = new AbortController();
  private readonly skipCounts: Record<string, number> = {};
  private errorsInARow = 0;
  private off = false;
  private counter = 0;
  private loop: Promise<void> | undefined;

  constructor(options: BranchReviewerOptions) {
    this.options = options;
    this.scheduler = new ReviewScheduler(options.everyMs, options.ceiling);
  }

  agentStarted(agent: number): void {
    this.scheduler.register(agent, this.options.clock.now());
    this.reviewedAt.delete(agent);
  }

  agentEnded(agent: number): void {
    this.scheduler.forget(agent);
  }

  get skips(): Readonly<Record<string, number>> {
    return this.skipCounts;
  }

  get switchedOff(): boolean {
    return this.off;
  }

  start(): void {
    const tick = Math.min(10_000, Math.max(250, this.options.everyMs / this.options.ceiling / 2));
    this.loop = (async () => {
      while (!this.stopSignal.signal.aborted && !this.off) {
        await this.options.clock.sleep(tick, this.stopSignal.signal).catch(() => undefined);
        if (this.stopSignal.signal.aborted) return;
        this.check();
      }
    })();
  }

  /** One look at the schedule: starts the reviews that are due and allowed. Exposed so that tests can drive it with a fake clock. */
  check(): void {
    if (this.off) return;
    const now = this.options.clock.now();
    for (const agent of this.scheduler.dueAgents(now)) {
      const reason = this.skipReason(agent);
      if (reason !== undefined) {
        this.skipCounts[reason] = (this.skipCounts[reason] ?? 0) + 1;
        if (reason === "limit") break; // the rest would be skipped for the same reason
        continue;
      }
      this.scheduler.begun(agent, now);
      this.launch(agent);
    }
  }

  private skipReason(agent: number): string | undefined {
    const target = this.options.target(agent);
    if (!target) return "not running";
    if (this.running.has(agent)) return "already running";
    if (this.running.size >= this.options.maxConcurrent) return "limit";
    const hold = this.options.holdReason();
    if (hold !== undefined) return "held";
    const replies = target.replies();
    if (replies === 0 || replies <= (this.reviewedAt.get(agent) ?? 0)) return "no new turn";
    return undefined;
  }

  private launch(agent: number): void {
    const target = this.options.target(agent) as ReviewTarget & { workDir: string };
    this.reviewedAt.set(agent, target.replies());
    const run = (this.options.review ?? runReview)({
      target,
      forkPath: join(this.options.dir, `${String(agent).padStart(3, "0")}-${++this.counter}.jsonl`),
      workDir: target.workDir,
      maxTurns: this.options.maxTurns,
      signal: this.stopSignal.signal,
      now: () => this.options.clock.now(),
      ...(this.options.output ? { output: this.options.output } : {}),
    }).then((outcome) => {
      this.running.delete(agent);
      if (this.stopSignal.signal.aborted) return;
      this.options.onResult(agent, outcome);
      this.errorsInARow = outcome.outcome === "error" ? this.errorsInARow + 1 : 0;
      if (this.errorsInARow >= MAX_ERRORS_IN_A_ROW && !this.off) {
        this.off = true;
        this.options.onOff(`${MAX_ERRORS_IN_A_ROW} reviews failed in a row (last: ${outcome.error ?? "unknown"})`);
      }
    });
    this.running.set(agent, run);
  }

  /** Ends the loop and the reviews that are running (their fork files are deleted) and waits for them. */
  async stop(): Promise<void> {
    this.stopSignal.abort();
    await Promise.allSettled([...this.running.values(), this.loop]);
  }
}

// ---------------------------------------------------------------- wiring

export interface BranchReviewDeps {
  settings: BranchReviewSettings;
  ceiling: number;
  clock: Clock;
  layout: RunLayout;
  gate: Gate;
  budget: Budget;
  /** The live workers; looked up at the moment of each review. */
  workers: ReadonlyMap<number, AgentWorker>;
  record(event: WithoutTs<RunEvent>): void;
}

/**
 * The orchestrator's whole knowledge of the branch review lives here: the defaults, where it listens (Gate pause, budget refusal, live workers) and
 * what it writes down. `Run` only calls this once and then tells the result about agents starting and ending. A fork file left by a killed run is swept first.
 */
export function startBranchReview(deps: BranchReviewDeps): BranchReviewer {
  const { settings, layout, gate, budget, workers, record } = deps;
  rmSync(layout.reviewDir, { recursive: true, force: true });
  mkdirSync(layout.reviewDir, { recursive: true });
  const reviewer = new BranchReviewer({
    everyMs: (settings.everyMinutes ?? 7) * 60_000,
    ceiling: deps.ceiling,
    maxTurns: settings.maxTurns ?? 6,
    maxConcurrent: settings.maxConcurrent ?? 3,
    ...(settings.output ? { output: settings.output } : {}),
    clock: deps.clock,
    dir: layout.reviewDir,
    target: (agent) => workers.get(agent)?.reviewTarget(),
    holdReason: () => (gate.paused ? "the Gate is paused" : budget.refusal()),
    onResult: (agent, outcome) =>
      record({
        type: "review",
        agent,
        outcome: outcome.outcome,
        ms: outcome.ms,
        tokens: outcome.tokens,
        ...(outcome.cacheRead !== undefined ? { cacheRead: outcome.cacheRead } : {}),
        ...(outcome.snapshot ? { snapshot: outcome.snapshot } : {}),
        ...(outcome.text ? { text: outcome.text } : outcome.error ? { text: `error: ${outcome.error}` } : {}),
      }),
    onOff: (reason) => record({ type: "review_off", reason }),
  });
  reviewer.start();
  return reviewer;
}
