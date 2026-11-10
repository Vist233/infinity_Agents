import { describe, expect, it } from "vitest";
import { type LadderEvent, type LadderState, REPLIES_TO_ADVANCE, rungsFor, startLadder, stepLadder } from "../src/ladder.ts";

/** Feeds events and keeps track of who is alive, the way the orchestrator would. */
function drive(ceiling = 100) {
  const first = startLadder(ceiling);
  let state: LadderState = first.state;
  const log: string[] = [];
  const feed = (event: LadderEvent) => {
    const step = stepLadder(state, event);
    state = step.state;
    if (step.change) log.push(`${step.change.reason}:${step.change.from}->${step.change.to}`);
    return step;
  };
  const liveAgents = () => Object.keys(state.live).map(Number);
  const everyoneReplies = (times: number) => {
    for (let round = 0; round < times; round++) for (const agent of liveAgents()) feed({ type: "reply", agent });
  };
  return {
    feed,
    liveAgents,
    everyoneReplies,
    log,
    first,
    get state() {
      return state;
    },
  };
}

describe("rungsFor", () => {
  it("is the ladder up to 100 by default", () => {
    expect(rungsFor(100)).toEqual([1, 2, 4, 8, 16, 32, 64, 100]);
  });
  it("cuts at the ceiling and ends exactly on it", () => {
    expect(rungsFor(5)).toEqual([1, 2, 4, 5]);
    expect(rungsFor(1)).toEqual([1]);
  });
});

describe("ladder", () => {
  it("starts with one agent", () => {
    const run = drive();
    expect(run.first.spawn).toEqual([1]);
  });

  it("advances to the next rung after 3 replies by every live agent", () => {
    const run = drive();
    run.everyoneReplies(REPLIES_TO_ADVANCE - 1);
    expect(run.liveAgents()).toHaveLength(1);
    const step = run.feed({ type: "reply", agent: 1 });
    expect(step.spawn).toEqual([2]);
    expect(run.liveAgents()).toHaveLength(2);
    expect(run.log).toEqual(["advance:1->2"]);
  });

  it("waits for the slowest agent", () => {
    const run = drive();
    run.everyoneReplies(3); // rung 2 now: agents 1, 2
    for (let i = 0; i < 5; i++) run.feed({ type: "reply", agent: 1 });
    expect(run.liveAgents()).toHaveLength(2);
    run.feed({ type: "reply", agent: 2 });
    run.feed({ type: "reply", agent: 2 });
    expect(run.liveAgents()).toHaveLength(2);
    run.feed({ type: "reply", agent: 2 });
    expect(run.liveAgents()).toHaveLength(4);
  });

  it("climbs the whole ladder to the ceiling and stays there", () => {
    const run = drive();
    for (let i = 0; i < 40; i++) run.everyoneReplies(1);
    expect(run.liveAgents()).toHaveLength(100);
    expect(run.log).toHaveLength(7);
    run.everyoneReplies(10);
    expect(run.liveAgents()).toHaveLength(100);
  });

  it("drops one rung on a throttle, retires the newest agents, records the limit and holds", () => {
    const run = drive();
    for (let i = 0; i < 9; i++) run.everyoneReplies(1); // reaches 8
    expect(run.liveAgents()).toHaveLength(8);
    const step = run.feed({ type: "throttle" });
    expect(step.retire).toEqual([8, 7, 6, 5]);
    expect(run.liveAgents()).toEqual([1, 2, 3, 4]);
    expect(run.state.limitRung).toBe(8);
    expect(run.log.at(-1)).toBe("throttle:8->4");
    run.everyoneReplies(20);
    expect(run.liveAgents()).toHaveLength(4); // held
  });

  it("counts a burst of throttles once", () => {
    const run = drive();
    for (let i = 0; i < 9; i++) run.everyoneReplies(1);
    run.feed({ type: "throttle" });
    run.feed({ type: "throttle" });
    run.feed({ type: "throttle" });
    expect(run.liveAgents()).toHaveLength(4);
    run.feed({ type: "reply", agent: 1 });
    run.feed({ type: "throttle" });
    expect(run.liveAgents()).toHaveLength(2); // a reply came in between: a second real drop
  });

  it("stays at one agent when the provider throttles at rung 1", () => {
    const run = drive();
    run.feed({ type: "throttle" });
    expect(run.liveAgents()).toEqual([1]);
    run.everyoneReplies(10);
    expect(run.liveAgents()).toEqual([1]);
    expect(run.state.limitRung).toBe(1);
  });

  it("does not advance when a throttle came in since the last change", () => {
    const run = drive();
    run.everyoneReplies(3); // rung 2: agents 1, 2
    run.feed({ type: "reply", agent: 1 });
    run.feed({ type: "throttle" }); // drops to 1, holds
    expect(run.liveAgents()).toHaveLength(1);
  });

  it("replaces a finished agent with a new one at the same rung", () => {
    const run = drive();
    run.everyoneReplies(3);
    const step = run.feed({ type: "agent_ended", agent: 1 });
    expect(step.spawn).toHaveLength(1);
    expect(run.liveAgents()).toHaveLength(2);
    expect(step.spawn[0]).toBeGreaterThan(2);
  });

  it("ignores the end of an agent it already retired", () => {
    const run = drive();
    for (let i = 0; i < 4; i++) run.everyoneReplies(1);
    const retired = run.feed({ type: "throttle" }).retire;
    for (const agent of retired) expect(run.feed({ type: "agent_ended", agent }).spawn).toEqual([]);
  });

  it("starts nothing more after finish and asks to stop everybody", () => {
    const run = drive();
    run.everyoneReplies(3);
    const step = run.feed({ type: "finish" });
    expect(step.retire.sort()).toEqual([1, 2]);
    expect(run.feed({ type: "agent_ended", agent: 1 }).spawn).toEqual([]);
    expect(run.liveAgents()).toEqual([]);
  });

  it("ignores a reply from an agent it does not know", () => {
    const run = drive();
    expect(run.feed({ type: "reply", agent: 99 }).spawn).toEqual([]);
  });

  it("does not mutate the state it was given", () => {
    const first = startLadder(100).state;
    const snapshot = JSON.stringify(first);
    stepLadder(first, { type: "reply", agent: 1 });
    expect(JSON.stringify(first)).toBe(snapshot);
  });
});
