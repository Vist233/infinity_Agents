/**
 * The ladder: how many agents are alive. A pure function over events; it holds no timers and starts nothing itself.
 * The caller feeds events in and obeys the answer (spawn these agent numbers, retire those).
 *
 * Rules (docs/02 section 3, confirmed):
 * - Rungs 1, 2, 4, 8, 16, 32, 64, 100, cut at the ceiling.
 * - Advance when the rung is full and every live agent has made at least `repliesToAdvance` replies since the last change, with no throttling answer.
 * - On a throttling answer: record that rung as the provider's limit, drop one rung, and hold (never climb again).
 *   A burst of throttles counts once: another drop needs a successful reply after the last change.
 * - A finished or stopped agent is replaced to stay at the rung's number.
 * - While braked (a component says the machine is under pressure, docs/16 section D) the ladder does not climb and no replacement is started; when the brake
 *   comes off, the missing agents are started. Unlike a throttle, a brake is not remembered.
 */
export const DEFAULT_RUNGS = [1, 2, 4, 8, 16, 32, 64, 100];
export const REPLIES_TO_ADVANCE = 3;

export function rungsFor(ceiling: number): number[] {
  const below = DEFAULT_RUNGS.filter((rung) => rung < ceiling);
  return [...below, ceiling];
}

export interface LadderState {
  readonly rungs: readonly number[];
  readonly rungIndex: number;
  readonly held: boolean;
  /** A pressure brake is on (states saved before the brake existed lack the field: that means off). */
  readonly braked?: boolean;
  readonly finished: boolean;
  /** Agent number -> successful replies since the last change. */
  readonly live: Readonly<Record<number, number>>;
  readonly nextAgent: number;
  /** False right after a drop until a reply comes in, so that one burst of throttles drops only one rung. */
  readonly dropArmed: boolean;
  /** The rung at which the provider throttled, once it has. */
  readonly limitRung: number | undefined;
}

export type LadderEvent =
  | { type: "reply"; agent: number }
  | { type: "agent_ended"; agent: number }
  | { type: "throttle" }
  | { type: "brake"; on: boolean }
  | { type: "finish" };

export interface RungChange {
  from: number;
  to: number;
  reason: "advance" | "throttle";
}

export interface LadderStep {
  state: LadderState;
  /** Agent numbers to start now (already counted as live). */
  spawn: number[];
  /** Agent numbers to stop now (already removed from live), newest first. */
  retire: number[];
  change?: RungChange;
}

const target = (state: LadderState): number => (state.finished ? 0 : (state.rungs[state.rungIndex] ?? 0));

export function startLadder(ceiling: number): LadderStep {
  const empty: LadderState = {
    rungs: rungsFor(ceiling),
    rungIndex: 0,
    held: false,
    finished: false,
    live: {},
    nextAgent: 1,
    dropArmed: true,
    limitRung: undefined,
  };
  return fillToTarget(empty);
}

export function stepLadder(state: LadderState, event: LadderEvent): LadderStep {
  switch (event.type) {
    case "finish":
      return retireAll({ ...state, finished: true });
    case "agent_ended":
      return fillToTarget(withoutAgent(state, event.agent));
    case "throttle":
      return onThrottle(state);
    case "brake":
      return onBrake(state, event.on);
    case "reply":
      return onReply(state, event.agent);
  }
}

function onReply(state: LadderState, agent: number): LadderStep {
  if (!(agent in state.live)) return { state, spawn: [], retire: [] };
  const counted = { ...state, live: { ...state.live, [agent]: (state.live[agent] ?? 0) + 1 }, dropArmed: true };
  return canAdvance(counted) ? advance(counted) : { state: counted, spawn: [], retire: [] };
}

function onBrake(state: LadderState, on: boolean): LadderStep {
  const next = { ...state, braked: on };
  return on || state.finished ? { state: next, spawn: [], retire: [] } : fillToTarget(next);
}

function canAdvance(state: LadderState): boolean {
  if (state.held || state.braked || state.finished) return false;
  if (state.rungIndex >= state.rungs.length - 1) return false;
  const counts = Object.values(state.live);
  return counts.length === target(state) && counts.every((replies) => replies >= REPLIES_TO_ADVANCE);
}

function advance(state: LadderState): LadderStep {
  const from = target(state);
  const next = resetCounters({ ...state, rungIndex: state.rungIndex + 1 });
  const step = fillToTarget(next);
  return { ...step, change: { from, to: target(next), reason: "advance" } };
}

function onThrottle(state: LadderState): LadderStep {
  if (state.finished) return { state, spawn: [], retire: [] };
  if (!state.dropArmed) return { state, spawn: [], retire: [] };
  const from = target(state);
  const lowered = resetCounters({
    ...state,
    rungIndex: Math.max(0, state.rungIndex - 1),
    held: true,
    limitRung: state.limitRung ?? from,
    dropArmed: false,
  });
  const step = trimToTarget(lowered);
  return { ...step, change: { from, to: target(lowered), reason: "throttle" } };
}

function resetCounters(state: LadderState): LadderState {
  const live = Object.fromEntries(Object.keys(state.live).map((agent) => [agent, 0]));
  return { ...state, live };
}

function withoutAgent(state: LadderState, agent: number): LadderState {
  const { [agent]: _gone, ...live } = state.live;
  return { ...state, live };
}

function fillToTarget(state: LadderState): LadderStep {
  if (state.braked) return { state, spawn: [], retire: [] };
  const missing = target(state) - Object.keys(state.live).length;
  if (missing <= 0) return { state, spawn: [], retire: [] };
  const spawn = Array.from({ length: missing }, (_, index) => state.nextAgent + index);
  const live = { ...state.live, ...Object.fromEntries(spawn.map((agent) => [agent, 0])) };
  return { state: { ...state, live, nextAgent: state.nextAgent + missing }, spawn, retire: [] };
}

function trimToTarget(state: LadderState): LadderStep {
  const agents = Object.keys(state.live).map(Number);
  const surplus = agents.length - target(state);
  if (surplus <= 0) return { state, spawn: [], retire: [] };
  const retire = agents.sort((a, b) => b - a).slice(0, surplus);
  const live = Object.fromEntries(Object.entries(state.live).filter(([agent]) => !retire.includes(Number(agent))));
  return { state: { ...state, live }, spawn: [], retire };
}

function retireAll(state: LadderState): LadderStep {
  const retire = Object.keys(state.live).map(Number);
  return { state: { ...state, live: {} }, spawn: [], retire };
}
