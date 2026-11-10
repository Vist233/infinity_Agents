import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LlmClient, createChatClient } from "sakura-agent";
import { type AgentEnd, type AgentWorker, startWorker } from "./agent-worker.ts";
import { Budget, totalTokens } from "./budget.ts";
import { type Clock, realClock } from "./clock.ts";
import { Gate, type GateEvent } from "./gate.ts";
import { type LadderEvent, type LadderState, type LadderStep, startLadder, stepLadder } from "./ladder.ts";
import type { LeanRunner } from "./lean-runner.ts";
import { createMode } from "./mode-factory.ts";
import type { Mode } from "./mode.ts";
import { hintFor, planHints } from "./planner.ts";
import { RungMeter } from "./rung-meter.ts";
import { type RunState, loadState, saveState } from "./run-state.ts";
import { type RunLayout, runLayout } from "./run-layout.ts";
import { RunRecorder } from "./run-recorder.ts";
import { RESCUE_MESSAGE, StuckDetector } from "./stuck.ts";
import type { TaskDefinition } from "./task.ts";
import type { Verifier } from "./verifier.ts";

export interface RunOptions {
  /** The run directory. Default: a new one under the task's `runsDir`. With `resume` it must be an existing run. */
  runDir?: string;
  /** Continue a run that was stopped or killed. */
  resume?: boolean;
  /** The user's stop. */
  signal?: AbortSignal;
  /** For tests: time, the model, Lean or the verifier. */
  clock?: Clock;
  createClient?: (gate: Gate) => LlmClient;
  leanRunner?: LeanRunner;
  verifier?: Verifier;
  /** How often silence and the state file are looked at (default one minute). */
  checkEveryMs?: number;
  /** How long a paused agent waits before it goes on (default one second). */
  pauseRetryMs?: number;
}

export interface RunOutcome {
  reason: string;
  runDir: string;
  proved: number[];
  tokensUsed: number;
}

/** Always plan a full list: a replacement agent needs a new hint even when the ladder is short. */
const MAX_HINTS_PLANNED = 16;
const DEFAULT_STUCK_MINUTES = 10;
const DEFAULT_PAUSE_MS = 5000;

/** Runs a task to the end (or to the user's stop) and returns why it ended. */
export async function runTask(task: TaskDefinition, options: RunOptions = {}): Promise<RunOutcome> {
  const clock = options.clock ?? realClock;
  const layout = runLayout(options.runDir ?? newRunDir(task, clock));
  mkdirSync(layout.root, { recursive: true });
  const prior = options.resume ? loadState(layout.state) : undefined;
  if (options.resume && !prior) throw new Error(`Nothing to resume in ${layout.root}`);
  if (prior?.finished === "proved" && task.stop === "first-success") return outcomeOf(layout, prior.finished, prior.proved, prior.tokensUsed);

  const run = new Run(task, options, layout, clock, prior);
  return run.execute();
}

function newRunDir(task: TaskDefinition, clock: Clock): string {
  const slug =
    task.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "task";
  return join(task.runsDir ?? "runs", `${slug}-${new Date(clock.now()).toISOString().replace(/[:.]/g, "-")}`);
}

const outcomeOf = (layout: RunLayout, reason: string, proved: number[], tokensUsed: number): RunOutcome => ({
  reason,
  runDir: layout.root,
  proved,
  tokensUsed,
});

/** The state of one run and the rules that connect the parts. The parts themselves (ladder, gate, budget, ...) are in their own modules. */
class Run {
  private readonly task: TaskDefinition;
  private readonly options: RunOptions;
  private readonly layout: RunLayout;
  private readonly clock: Clock;
  private readonly prior: RunState | undefined;

  private readonly recorder: RunRecorder;
  private readonly budget: Budget;
  private readonly gate: Gate;
  private readonly stuck: StuckDetector;
  private readonly meter: RungMeter;
  private readonly workers = new Map<number, AgentWorker>();
  private readonly proved: number[];
  private readonly stopWatching = new AbortController();
  private readonly allEnded: Array<Promise<void>> = [];

  private ladder!: LadderState;
  /** The ladder as it was when the run was told to stop, so that a resume starts the same agents again. */
  private ladderAtStop: LadderState | undefined;
  private hints: string[] = [];
  private mode!: Mode;
  private client!: LlmClient;
  private failures: number;
  private finishing: string | undefined;
  private readonly startedAt: number;
  private budgetRefusalLogged = false;
  private closed = false;
  private resolveOutcome!: (outcome: RunOutcome) => void;
  private readonly outcome = new Promise<RunOutcome>((resolve) => {
    this.resolveOutcome = resolve;
  });

  constructor(task: TaskDefinition, options: RunOptions, layout: RunLayout, clock: Clock, prior: RunState | undefined) {
    this.task = task;
    this.options = options;
    this.layout = layout;
    this.clock = clock;
    this.prior = prior;
    this.startedAt = prior?.startedAt ?? clock.now();
    this.proved = [...(prior?.proved ?? [])];
    this.failures = prior?.failures ?? 0;
    this.recorder = new RunRecorder(layout, clock);
    this.gate = new Gate({
      now: () => clock.now(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
      defaultPauseMs: DEFAULT_PAUSE_MS,
      refusal: () => this.budget.refusal(),
      onEvent: (event) => this.onGateEvent(event),
    });
    this.budget = new Budget(task.tokens, () => this.gate.inflight);
    if (prior) this.budget.restore(prior.tokensUsed, prior.requests);
    this.stuck = new StuckDetector({
      clock,
      stuckAfterMs: (task.stuckMinutes ?? DEFAULT_STUCK_MINUTES) * 60_000,
      isExcused: (agent) => this.workers.get(agent)?.excused() ?? true,
    });
    this.meter = new RungMeter(clock.now());
  }

  async execute(): Promise<RunOutcome> {
    this.recorder.event({ type: "run_start", task: this.task.name, ceiling: this.task.agents, resumed: this.prior !== undefined });
    try {
      await this.prepare();
    } catch (error) {
      this.recorder.event({ type: "run_end", reason: `failed to start: ${String(error)}`, tokensUsed: this.budget.tokensUsed, proved: this.proved });
      this.recorder.report();
      throw error;
    }
    this.options.signal?.addEventListener("abort", () => void this.finish("stopped"), { once: true });
    const { state, spawn } = this.prior
      ? { state: { ...this.prior.ladder, finished: false }, spawn: Object.keys(this.prior.ladder.live).map(Number) }
      : startLadder(this.task.agents);
    this.ladder = state;
    for (const agent of spawn) this.startAgent(agent, this.prior !== undefined);
    this.saveState();
    if (this.options.signal?.aborted) void this.finish("stopped");
    void this.watchLoop();
    return this.outcome;
  }

  private async prepare(): Promise<void> {
    this.mode = createMode(this.task, this.layout, this.options);
    await this.mode.prepare();
    this.client = this.gate.wrap(
      this.options.createClient ? this.options.createClient(this.gate) : createChatClient({ ...this.task.model, retry: this.gate.retry }),
    );
    this.hints = this.prior?.hints ?? (await this.plan());
  }

  private async plan(): Promise<string[]> {
    return planHints({ client: this.client, statement: this.mode.plannerSubject, count: MAX_HINTS_PLANNED });
  }

  // ----- agents -----

  private startAgent(number: number, resume: boolean): void {
    this.stuck.register(number);
    this.recorder.lifecycle(number, "started", resume ? "resumed" : "");
    const worker = startWorker({
      number,
      layout: this.layout,
      client: this.client,
      setup: this.mode.agentSetup(hintFor(this.hints, number)),
      resume,
      clock: this.clock,
      gate: this.gate,
      pauseRetryMs: this.options.pauseRetryMs ?? 1000,
      hooks: {
        onActivity: () => this.stuck.touch(number),
        onReply: () => this.apply(stepLadder(this.ladder, { type: "reply", agent: number })),
        onCommit: (commit, turn) => this.recorder.commit(number, commit, turn),
        onSubmit: async (submission, info) => this.onSubmit(number, submission.code, submission.verdict, info),
      },
    });
    this.workers.set(number, worker);
    this.allEnded.push(worker.done.then((end) => this.onAgentEnd(number, end)));
  }

  private async onSubmit(
    agent: number,
    code: string,
    verdict: { proved: boolean; reason: string },
    info: { commit: string | null; steps: number; elapsedMs: number },
  ): Promise<void> {
    this.recorder.submit(agent, { code, proved: verdict.proved, reason: verdict.reason, ...info });
    if (!verdict.proved) return;
    writeFileSync(this.layout.provedMarker(agent), `accepted by the orchestrator at ${new Date(this.clock.now()).toISOString()}\n`);
    this.proved.push(agent);
    this.saveState();
    if (this.task.stop === "first-success") void this.finish("proved");
  }

  private onAgentEnd(number: number, end: AgentEnd): void {
    this.workers.delete(number);
    this.stuck.forget(number);
    const detail = [end.reason, end.cancelled, end.detail].filter(Boolean).join(": ");
    this.recorder.lifecycle(number, end.cancelled === "stuck" ? "stopped" : "ended", detail);
    if (this.finishing || end.cancelled === "retire") return;
    if (end.reason !== "done") this.failures += 1;
    if (this.failures > this.task.agents * 5 + 10) return void this.finish("too many agent failures");
    this.apply(stepLadder(this.ladder, { type: "agent_ended", agent: number }));
  }

  // ----- the ladder -----

  private apply(step: LadderStep): void {
    this.ladder = step.state;
    if (step.change) {
      const stats = this.meter.closeRung(this.clock.now());
      this.recorder.event({ type: "rung", from: step.change.from, to: step.change.to, reason: step.change.reason, ...stats });
      this.recorder.report();
    }
    for (const agent of step.retire) this.workers.get(agent)?.cancel("retire");
    if (!this.finishing) for (const agent of step.spawn) this.startAgent(agent, false);
    if (step.change || step.spawn.length > 0 || step.retire.length > 0) this.saveState();
  }

  private feed(event: LadderEvent): void {
    this.apply(stepLadder(this.ladder, event));
  }

  // ----- the gate -----

  private onGateEvent(event: GateEvent): void {
    switch (event.type) {
      case "usage":
        this.budget.record(event.usage);
        this.meter.recordReply(event.latencyMs, totalTokens(event.usage));
        return;
      case "throttle":
        this.recorder.event({ type: "throttle", delayMs: event.delayMs });
        this.meter.recordThrottle();
        if (this.ladder) this.feed({ type: "throttle" });
        return;
      case "quota":
        this.recorder.event({ type: "quota", message: event.message });
        void this.finish("quota");
        return;
      case "refused":
        if (!this.budgetRefusalLogged) this.recorder.event({ type: "budget_refused", reason: event.reason });
        this.budgetRefusalLogged = true;
        void this.finish("budget");
        return;
    }
  }

  // ----- watching -----

  private async watchLoop(): Promise<void> {
    const every = this.options.checkEveryMs ?? 60_000;
    while (!this.finishing) {
      await this.clock.sleep(every, this.stopWatching.signal).catch(() => {});
      if (this.finishing) return;
      for (const action of this.stuck.check()) {
        const worker = this.workers.get(action.agent);
        if (action.type === "rescue") {
          this.recorder.event({ type: "rescue", agent: action.agent, rescue: action.rescue });
          this.recorder.lifecycle(action.agent, "rescued", `rescue ${action.rescue}`);
          worker?.rescue(RESCUE_MESSAGE);
        } else {
          worker?.cancel("stuck");
        }
      }
      this.saveState();
    }
  }

  // ----- the end -----

  private async finish(reason: string): Promise<void> {
    if (this.finishing) return;
    this.finishing = reason;
    this.ladderAtStop = this.ladder;
    this.stopWatching.abort();
    this.apply(stepLadder(this.ladder, { type: "finish" }));
    this.drainOrCancel(reason);
    await Promise.allSettled(this.allEnded);
    this.recorder.event({ type: "run_end", reason, tokensUsed: this.budget.tokensUsed, proved: this.proved });
    this.saveState(reason);
    this.recorder.report();
    this.closed = true;
    this.resolveOutcome(outcomeOf(this.layout, reason, this.proved, this.budget.tokensUsed));
  }

  /** A budget or quota stop is soft: requests in flight finish and nothing new starts. Any other end cancels the agents at once. */
  private drainOrCancel(reason: string): void {
    if (reason === "budget" || reason === "quota") {
      this.gate.stop(`run stopped: ${reason}`, { silent: true });
      return;
    }
    for (const worker of this.workers.values()) worker.cancel("finish");
  }

  private saveState(finished: string | null = null): void {
    if (this.closed) return;
    saveState(this.layout.state, {
      version: 1,
      task: this.task.name,
      startedAt: this.startedAt,
      hints: this.hints,
      ladder: this.ladderAtStop ?? this.ladder,
      proved: this.proved,
      tokensUsed: this.budget.tokensUsed,
      requests: this.budget.requestCount,
      failures: this.failures,
      finished,
    });
  }
}
