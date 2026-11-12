import { realClock } from "./clock.ts";
import { type Capacity, type TaskProfile, cpuOf, describeCapacity, recommendCapacity } from "./capacity.ts";
import type { ModelConfig } from "sakura-agent";
import { limitedEnvironment, limitsOf } from "./command-limits.ts";
import { DEFAULT_COMMAND_TIMEOUT_MINUTES } from "./code-mode.ts";
import { defaultComponents } from "./defaults.ts";
import { type RunOptions, type RunOutcome, newRunDir, runTask } from "./orchestrator.ts";
import { readMachineFacts } from "./proc-readings.ts";
import type { RunEvent } from "./records.ts";
import { readRunEvents, readRunStatus, type RunStatus } from "./run-status.ts";
import { SlotGate } from "./slot-gate.ts";
import { MAX_AGENTS, type BranchReviewSettings, type TaskDefinition } from "./task.ts";

/**
 * The one way to start a run, for a person (bin/infinity.ts) and for an Agent (sakura-tools.ts): `startRun(package, options)` returns a handle at once, the run goes on in
 * this process. Nothing here reads the command line or the environment: the caller gives the model and every choice.
 */

/** What a task package gets to build its task from: the choices of the caller, with the machine's recommendation filled in where the caller chose nothing. */
export interface PackageContext {
  agents: number;
  /** The profile of the task with the caller's `threads`, `memGb` and `heavyShare` laid over it. */
  profile: TaskProfile;
  model: ModelConfig;
  tokens: number | undefined;
  /** Left out when the caller switched the branch review off. */
  branchReview: BranchReviewSettings | undefined;
  commandMinutes: number | undefined;
  runsDir: string;
}

/** A task, small enough to write in one file: its name, a line for `--help`, its profile and defaults, and how to build the task from the caller's choices. */
export interface TaskPackage {
  name: string;
  summary: string;
  profile?: TaskProfile;
  /** Used when the caller gives no value. */
  defaults?: { tokens?: number; wallMinutes?: number };
  build(context: PackageContext): TaskDefinition;
}

export interface LaunchOptions {
  model: ModelConfig;
  /** The number of agents. The caller's number always wins; without it the machine's recommendation is used. */
  agents?: number;
  tokens?: number;
  /** The run ends in order after this many minutes. */
  wallMinutes?: number;
  /** `false` leaves the branch review out; otherwise minutes between two reviews of one agent (default 3). */
  review?: false | { everyMinutes?: number };
  threads?: number;
  memGb?: number;
  heavyShare?: number;
  /** The CPU slot gate: `true` (default) takes the recommended number of slots, a number sets it, `false` turns it off. */
  gate?: boolean | number;
  pressureBrake?: boolean;
  commandMinutes?: number;
  runsDir?: string;
  /** Continue the run in this directory. */
  resume?: string;
  createEnvironment?: RunOptions["createEnvironment"];
  /** Recorded in run-facts.json. */
  commandLine?: string[];
  /** The user's stop (the handle's `stop()` does the same). */
  signal?: AbortSignal;
  /** For tests: laid over the options given to `runTask` (a scripted model, a fake clock). */
  testing?: Partial<RunOptions>;
}

export interface Recommendation {
  agents: number;
  capacity: Capacity;
  foreignBusyCores: number;
  /** The lines to show the user before the run: the recommendation and any foreign load. */
  lines: string[];
}

/** What this machine can carry for this profile, and the number of agents to use: the caller's own number always wins. Reads the machine for half a second. */
export async function recommendRun(profile: TaskProfile, requested?: number): Promise<Recommendation> {
  const facts = await readMachineFacts();
  const capacity = recommendCapacity(facts, profile);
  const lines = [describeCapacity(capacity, requested)];
  const busy = facts.busyCores ?? 0;
  if (busy >= 0.5) lines.push(`Foreign load: about ${busy.toFixed(1)} cores are busy with other work; they are left out of the slots and only measured.`);
  return { agents: Math.min(MAX_AGENTS, requested ?? capacity.agents), capacity, foreignBusyCores: busy, lines };
}

export const DEFAULT_REVIEW_MINUTES = 3;

/** The reasons these options cannot be used together, as words; empty when they can. */
export function launchProblems(options: LaunchOptions): string[] {
  const problems: string[] = [];
  const positive = (name: string, value: number | undefined) => {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) problems.push(`${name} must be a number above 0`);
  };
  if (options.agents !== undefined && !(Number.isInteger(options.agents) && options.agents >= 1 && options.agents <= MAX_AGENTS))
    problems.push(`agents must be a whole number from 1 to ${MAX_AGENTS}`);
  for (const [name, value] of [
    ["tokens", options.tokens],
    ["wallMinutes", options.wallMinutes],
    ["threads", options.threads],
    ["memGb", options.memGb],
    ["heavyShare", options.heavyShare],
    ["commandMinutes", options.commandMinutes],
  ] as const)
    positive(name, value);
  if (options.heavyShare !== undefined && options.heavyShare > 1) problems.push("heavyShare is a share: 1 at most");
  if (typeof options.gate === "number" && !(Number.isInteger(options.gate) && options.gate >= 1))
    problems.push("gate slots must be a whole number of 1 or more");
  return problems;
}

/** A started run. The run goes on in this process; everything but `done` and `stop` reads the run's files. */
export interface RunHandle {
  runDir: string;
  agents: number;
  recommendation: Recommendation;
  /** Settles when the run has ended (the outcome says why). */
  done: Promise<RunOutcome>;
  /** Ends the run in order (agents stopped, report written) and waits for it. */
  stop(): Promise<RunOutcome>;
  /** The state of the run from its files. */
  status(): RunStatus;
  /** The events from position `from` on, and the position to ask for next. */
  events(from?: number): { events: RunEvent[]; next: number };
}

export { readRunEvents, readRunStatus };
export type { RunEvent, RunOutcome, RunStatus };

/** Starts a run of a task package and returns at once. Refuses conflicting or impossible options before anything starts. */
export async function startRun(pack: TaskPackage, options: LaunchOptions): Promise<RunHandle> {
  const problems = launchProblems(options);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const base = pack.profile ?? {};
  const profile: TaskProfile = {
    ...base,
    cpu: {
      ...cpuOf(base),
      ...(options.threads === undefined ? {} : { threadsPerJob: options.threads }),
      ...(options.memGb === undefined ? {} : { memPerJobGb: options.memGb }),
      ...(options.heavyShare === undefined ? {} : { heavyShare: options.heavyShare }),
    },
  };
  const recommendation = await recommendRun(profile, options.agents);
  const agents = recommendation.agents;
  const gateSlots = options.gate === false ? undefined : typeof options.gate === "number" ? options.gate : recommendation.capacity.cpuSlots;
  const gate = gateSlots === undefined ? undefined : new SlotGate(gateSlots);
  const notes = options.review === false ? ["Branch review: off. No outside reviewer looks at the agents' work."] : [];
  const commandMinutes = options.commandMinutes;
  const task = pack.build({
    agents,
    profile,
    model: options.model,
    tokens: options.tokens ?? pack.defaults?.tokens,
    branchReview:
      options.review === false ? undefined : { everyMinutes: options.review?.everyMinutes ?? DEFAULT_REVIEW_MINUTES, maxTurns: 6, maxConcurrent: 2 },
    commandMinutes,
    runsDir: options.runsDir ?? "runs",
  });
  const runDir = options.resume ?? newRunDir(task, realClock);
  const stopping = new AbortController();
  options.signal?.addEventListener("abort", () => stopping.abort(), { once: true });
  const wallMinutes = options.wallMinutes ?? pack.defaults?.wallMinutes ?? 0;
  const timer = wallMinutes > 0 ? setTimeout(() => stopping.abort(), wallMinutes * 60_000) : undefined;
  timer?.unref();
  const done = runTask(task, {
    ...options.testing,
    runDir,
    signal: stopping.signal,
    createEnvironment: limitedEnvironment(limitsOf(profile), options.createEnvironment),
    ...(gate ? { gate } : {}),
    ...(options.resume ? { resume: true } : {}),
    components: defaultComponents({
      ceiling: agents,
      ...(options.commandLine ? { commandLine: options.commandLine } : {}),
      foreignBusyCores: recommendation.foreignBusyCores,
      notes,
      pressureBrake: options.pressureBrake === true,
      commandTimeoutMinutes: commandMinutes ?? DEFAULT_COMMAND_TIMEOUT_MINUTES,
      ...(gate ? { gate } : {}),
    }),
  }).finally(() => clearTimeout(timer));
  return {
    runDir,
    agents,
    recommendation,
    done,
    stop: () => {
      stopping.abort();
      return done;
    },
    status: () => readRunStatus(runDir),
    events: (from) => readRunEvents(runDir, from),
  };
}
