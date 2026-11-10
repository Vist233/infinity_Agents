import { describe, expect, it } from "vitest";
import { MAX_RESCUES, RESCUE_MESSAGE, StuckDetector } from "../src/stuck.ts";
import { FakeClock } from "./support/fake-clock.ts";

const MINUTE = 60_000;

function setup(excused: (agent: number) => boolean = () => false) {
  const clock = new FakeClock();
  const detector = new StuckDetector({ clock, stuckAfterMs: 5 * MINUTE, isExcused: excused });
  return { clock, detector };
}

describe("StuckDetector", () => {
  it("does not flag an agent that is quiet for less than the limit", async () => {
    const { clock, detector } = setup();
    detector.register(1);
    await clock.advance(4 * MINUTE);
    expect(detector.check()).toEqual([]);
  });

  it("rescues an agent that was silent for the limit, with the message", async () => {
    const { clock, detector } = setup();
    detector.register(1);
    await clock.advance(5 * MINUTE);
    expect(detector.check()).toEqual([{ type: "rescue", agent: 1, rescue: 1, message: RESCUE_MESSAGE }]);
  });

  it("any event resets the silence", async () => {
    const { clock, detector } = setup();
    detector.register(1);
    await clock.advance(4 * MINUTE);
    detector.touch(1);
    await clock.advance(4 * MINUTE);
    expect(detector.check()).toEqual([]);
    await clock.advance(1 * MINUTE);
    expect(detector.check()).toHaveLength(1);
  });

  it("gives a rescued agent a full silence period before the next check flags it", async () => {
    const { clock, detector } = setup();
    detector.register(1);
    await clock.advance(5 * MINUTE);
    detector.check();
    await clock.advance(1 * MINUTE);
    expect(detector.check()).toEqual([]);
  });

  it("rescues at most three times, then stops the agent", async () => {
    const { clock, detector } = setup();
    detector.register(1);
    const seen: string[] = [];
    for (let round = 0; round < MAX_RESCUES + 1; round++) {
      await clock.advance(5 * MINUTE);
      for (const action of detector.check()) seen.push(action.type === "rescue" ? `rescue ${action.rescue}` : "stop");
    }
    expect(seen).toEqual(["rescue 1", "rescue 2", "rescue 3", "stop"]);
    await clock.advance(60 * MINUTE);
    expect(detector.check()).toEqual([]); // forgotten after the stop
  });

  it("never flags an excused agent (waiting in the Gate or a pool, a tool or a background process running)", async () => {
    let excused = true;
    const { clock, detector } = setup(() => excused);
    detector.register(1);
    await clock.advance(60 * MINUTE);
    expect(detector.check()).toEqual([]);
    excused = false;
    expect(detector.check()).toHaveLength(1);
  });

  it("tracks agents separately and forgets those that ended", async () => {
    const { clock, detector } = setup((agent) => agent === 2);
    detector.register(1);
    detector.register(2);
    detector.register(3);
    detector.forget(3);
    await clock.advance(5 * MINUTE);
    expect(detector.check().map((action) => action.agent)).toEqual([1]);
    expect(detector.rescuesOf(1)).toBe(1);
    expect(detector.rescuesOf(3)).toBe(0);
  });
});

describe("FakeClock", () => {
  it("wakes sleepers in order of time", async () => {
    const clock = new FakeClock();
    const woke: number[] = [];
    clock.sleep(30).then(() => woke.push(30));
    clock.sleep(10).then(() => woke.push(10));
    await clock.advance(50);
    expect(woke).toEqual([10, 30]);
    expect(clock.now()).toBe(50);
  });

  it("drops a sleeper that is aborted", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(100, controller.signal);
    controller.abort(new Error("stop"));
    await expect(sleeping).rejects.toThrow("stop");
    expect(clock.sleeping).toBe(0);
  });
});
