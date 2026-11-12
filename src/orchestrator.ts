import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type LlmClient, type ModelConfig, createChatClient } from "sakura-agent";
import { type AgentEnd, type AgentWorker, type WorkerEnvironmentFactory, startWorker } from "./agent-worker.ts";
import { Budget, totalTokens } from "./budget.ts";
import { replacementWait } from "./backoff.ts";
import { type Clock, realClock } from "./clock.ts";
import type { RunComponent } from "./component.ts";
import { defaultComponents } from "./defaults.ts";
import { allowSlowConnects } from "./network.ts";
import { Gate, type GateEvent } from "./gate.ts";
import { type LadderEvent, type LadderState, type LadderStep, startLadder, stepLadder } from "./ladder.ts";
import { type ModeContext, createMode, isFinishedBefore, reportKindOf } from "./mode-factory.ts";
import type { Mode, Progress, Submission, SubmitInfo } from "./mode.ts";
import { hintFor, planHints } from "./planner.ts";
import { type BranchReviewer, startBranchReview } from "./review-loop.ts";
import type { SlotGate } from "./slot-gate.ts";
import { RungMeter } from "./rung-meter.ts";
import { type RunState, loadState, saveState } from "./run-state.ts";
import { type RunLayout, runLayout } from "./run-layout.ts";
import { RunRecorder } from "./run-recorder.ts";
import { RESCUE_MESSAGE, StuckDetector } from "./stuck.ts";
import type { TaskDefinition } from "./task.ts";

export interface RunOptions {
  /** The run directory. Default: a new one under the task's `runsDir`. With `resume` it must be an existing run. */
  runDir?: string;
  /** Continue a run that was stopped or killed. */
  resume?: boolean;
  /** The user's stop. */
  signal?: AbortSignal;
  /** Deployment-owned environment for file and shell tools. It must enforce its own access and resource policy. */
  createEnvironment?: WorkerEnvironmentFactory;
  /** The CPU slot gate that heavy commands of code mode wait at (docs/16 section C); the same object the `slotGate` component reports on. Default: none. */
  gate?: SlotGate;
  /** Parts that watch the run (the machine sampler); default: `defaultComponents()`. */
  components?: RunComponent[];
  /** For tests: time, the model, and the mode (for example a math mode with a fake verifier). */
  mode?: (context: ModeContext) => Mode;
  clock?: Clock;
  createClient?: (gate: Gate) => LlmClient;
  /** How often silence and the state file are looked at (default one minute). */
  checkEveryMs?: number;
  /** How long a paused agent waits before it goes on (default one second). */
  pauseRetryMs?: number;
  /** The first wait before a failed agent is replaced (default one second; doubles with every failure in a row, up to a minute). */
  replacementWaitMs?: number;
}

export interface RunOutcome {
  reason: string;
  runDir: string;
  proved: number[];
  tokensUsed: number;
  /** Code mode: the best score of a scored submit (null when there was none). */
  bestScore?: number | null;
}

/** Always plan a full list: a replacement agent needs a new hint even when the ladder is short. */
const MAX_HINTS_PLANNED = 16;
const DEFAULT_STUCK_MINUTES = 10;
const DEFAULT_PAUSE_MS = 5000;

/** Runs a task to the end (or to the user's stop) and returns why it ended. */
export async function runTask(task: TaskDefinition, options: RunOptions = {}): Promise<RunOutcome> {
  allowSlowConnects();
  const clock = options.clock ?? realClock;
  const layout = runLayout(options.runDir ?? newRunDir(task, clock));
  mkdirSync(layout.root, { recursive: true });
  const prior = options.resume ? loadState(layout.state) : undefined;
  if (options.resume && !prior) throw new Error(`Nothing to resume in ${layout.root}`);
  if (prior && isFinishedBefore(task, prior)) return outcomeOf(layout, prior.finished as string, prior.proved, prior.tokensUsed);

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

const outcomeOf = (layout: RunLayout, reason: string, proved: number[], tokensUsed: number, bestScore?: number | null): RunOutcome => ({
  reason,
  runDir: layout.root,
  proved,
  tokensUsed,
  ...(bestScore !== undefined ? { bestScore } : {}),
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
  private readonly stopWatching = new AbortController();
  private readonly allEnded: Array<Promise<void>> = [];
  private branch: BranchReviewer | undefined;
  private readonly components: RunComponent[];

  private ladder!: LadderState;
  /** The ladder as it was when the run was told to stop, so that a resume starts the same agents again. */
  private ladderAtStop: LadderState | undefined;
  private hints: string[] = [];
  private mode!: Mode;
  private client!: LlmClient;
  private failures: number;
  private consecutiveFailures = 0;
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
    this.components = options.components ?? defaultComponents();
    this.startedAt = prior?.startedAt ?? clock.now();
    this.failures = prior?.failures ?? 0;
    this.recorder = new RunRecorder(layout, clock, reportKindOf(task));
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
      this.mode?.finish?.([]);
      this.recorder.event({ type: "run_end", reason: `failed to start: ${String(error)}`, tokensUsed: this.budget.tokensUsed, proved: this.progress().proved });
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
    for (const component of this.components)
      component.start({
        layout: this.layout,
        clock: this.clock,
        view: { rung: () => this.ladder.rungs[this.ladder.rungIndex] ?? this.workers.size, agents: () => this.workers.size },
        note: (message) => this.recorder.event({ type: "warning", message }),
        hold: (on) => {
          if (!this.finishing && this.ladder && Boolean(this.ladder.braked) !== on) this.feed({ type: "brake", on });
        },
      });
    if (this.options.signal?.aborted) void this.finish("stopped");
    void this.watchLoop();
    return this.outcome;
  }

  private async prepare(): Promise<void> {
    this.client = this.gate.wrap(
      this.options.createClient ? this.options.createClient(this.gate) : createChatClient({ ...this.task.model, retry: this.gate.retry }),
    );
    const clientFor = (model?: ModelConfig) => (model ? this.gate.wrap(createChatClient({ ...model, retry: this.gate.retry })) : this.client);
    this.mode = (this.options.mode ?? createMode)({
      task: this.task,
      layout: this.layout,
      clock: this.clock,
      clientFor,
      ...(this.options.gate ? { gate: this.options.gate } : {}),
    });
    if (this.prior) this.mode.restore({ proved: this.prior.proved, bestScore: this.prior.bestScore ?? null });
    await this.mode.prepare();
    for (const message of this.mode.warnings?.() ?? []) this.recorder.event({ type: "warning", message });
    if (this.mode.branchReview) {
      this.branch = startBranchReview({
        settings: this.mode.branchReview,
        ceiling: this.task.agents,
        clock: this.clock,
        layout: this.layout,
        gate: this.gate,
        budget: this.budget,
        workers: this.workers,
        record: (event) => this.recorder.event(event),
      });
    }
    this.hints = this.prior?.hints ?? (await this.plan());
  }

  private async plan(): Promise<string[]> {
    return planHints({ client: this.client, statement: this.mode.plannerSubject, count: MAX_HINTS_PLANNED, kind: this.mode.kind });
  }

  // ----- agents -----

  private startAgent(number: number, resume: boolean): void {
    this.stuck.register(number);
    this.branch?.agentStarted(number);
    this.recorder.lifecycle(number, "started", resume ? "resumed" : "");
    const worker = startWorker({
      number,
      layout: this.layout,
      client: this.client,
      setup: this.mode.agentSetup(hintFor(this.hints, number), number),
      ...(this.options.createEnvironment ? { createEnvironment: this.options.createEnvironment } : {}),
      resume,
      clock: this.clock,
      gate: this.gate,
      pauseRetryMs: this.options.pauseRetryMs ?? 1000,
      hooks: {
        onActivity: () => this.stuck.touch(number),
        onReply: () => {
          this.consecutiveFailures = 0;
          this.apply(stepLadder(this.ladder, { type: "reply", agent: number }));
        },
        onCommit: (commit, turn) => this.recorder.commit(number, commit, turn),
        onDenied: (denial) => this.recorder.event({ type: "action_denied", agent: number, ...denial }),
        onSubmit: async (submission, info) => this.onSubmit(number, submission, info),
      },
    });
    this.workers.set(number, worker);
    this.allEnded.push(worker.done.then((end) => this.onAgentEnd(number, end)));
  }

  /** The mode takes the submit; the orchestrator only obeys what it says about the run. */
  private async onSubmit(agent: number, submission: Submission, info: SubmitInfo): Promise<void> {
    const effect = this.mode.accept(agent, submission, info, { recorder: this.recorder, layout: this.layout, clock: this.clock });
    if (effect.changed) this.saveState();
    if (effect.finish) void this.finish(effect.finish);
  }

  private async onAgentEnd(number: number, end: AgentEnd): Promise<void> {
    this.workers.delete(number);
    this.stuck.forget(number);
    this.branch?.agentEnded(number);
    const detail = [end.reason, end.cancelled, end.detail].filter(Boolean).join(": ");
    this.recorder.lifecycle(number, end.cancelled === "stuck" ? "stopped" : "ended", detail);
    if (this.finishing || end.cancelled === "retire") return;
    if (end.reason !== "done") {
      this.failures += 1;
      this.consecutiveFailures += 1;
    }
    if (this.failures > this.task.agents * 5 + 10) return void this.finish("too many agent failures");
    const wait = replacementWait(end.reason !== "done", this.consecutiveFailures, this.options.replacementWaitMs);
    if (wait > 0) await this.clock.sleep(wait, this.stopWatching.signal).catch(() => undefined);
    if (this.finishing) return;
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
        this.recorder.event({ type: "throttle", delayMs: event.delayMs, ...(event.cause ? { cause: event.cause } : {}) });
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
    await this.branch?.stop();
    if (this.branch) this.recorder.event({ type: "review_skips", skips: { ...this.branch.skips } });
    const live = [...this.workers.keys()];
    await Promise.allSettled(this.allEnded);
    await Promise.allSettled(this.components.map((component) => component.stop()));
    this.mode.finish?.(live);
    this.recorder.event({
      type: "run_end",
      reason,
      tokensUsed: this.budget.tokensUsed,
      proved: this.progress().proved,
      ...this.mode.endFields(),
    });
    this.saveState(reason);
    this.recorder.report();
    this.closed = true;
    this.resolveOutcome(outcomeOf(this.layout, reason, this.progress().proved, this.budget.tokensUsed, this.mode.endFields().bestScore));
  }

  /** A budget or quota stop is soft: requests in flight finish and nothing new starts. Any other end cancels the agents at once. */
  private drainOrCancel(reason: string): void {
    if (reason === "budget" || reason === "quota") {
      this.gate.stop(`run stopped: ${reason}`, { silent: true });
      return;
    }
    for (const worker of this.workers.values()) worker.cancel("finish");
  }

  /** What the mode has so far; before the mode exists (a failed start), what the run had when it was resumed. */
  private progress(): Progress {
    return this.mode?.progress() ?? { proved: [...(this.prior?.proved ?? [])], bestScore: this.prior?.bestScore ?? null };
  }

  private saveState(finished: string | null = null): void {
    if (this.closed) return;
    saveState(this.layout.state, {
      version: 1,
      task: this.task.name,
      startedAt: this.startedAt,
      hints: this.hints,
      ladder: this.ladderAtStop ?? this.ladder,
      proved: this.progress().proved,
      bestScore: this.progress().bestScore,
      tokensUsed: this.budget.tokensUsed,
      requests: this.budget.requestCount,
      failures: this.failures,
      finished,
    });
  }
}
