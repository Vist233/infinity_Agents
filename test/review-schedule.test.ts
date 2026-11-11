import type { Agent } from "sakura-agent";
import { describe, expect, it } from "vitest";
import { AdviceBox } from "../src/agent-worker.ts";
import { BranchReviewer } from "../src/review-loop.ts";
import type { ReviewOutcome, ReviewTarget } from "../src/review-run.ts";
import { ReviewScheduler } from "../src/review-schedule.ts";
import { FakeClock } from "./support/fake-clock.ts";

const MINUTE = 60_000;

describe("ReviewScheduler", () => {
  it("gives every agent its own slot, spreads 30 agents evenly over the interval, and gives a replacement the slot of its number", () => {
    const scheduler = new ReviewScheduler(7 * MINUTE, 30);
    for (let agent = 1; agent <= 30; agent += 1) scheduler.register(agent, 0);
    const slots = Array.from({ length: 30 }, (_, index) => scheduler.slot(index + 1));
    expect(new Set(slots).size).toBe(30);
    const due = Array.from({ length: 30 }, (_, index) => scheduler.nextDue(index + 1) as number).sort((a, b) => a - b);
    const gaps = due.slice(1).map((time, index) => time - (due[index] as number));
    expect(gaps.every((gap) => Math.abs(gap - (7 * MINUTE) / 30) < 1)).toBe(true); // one about every 14 seconds
    expect(due[0]).toBe(7 * MINUTE); // the first one only after a full interval of work
    expect(scheduler.slot(31)).toBe(0); // agent 31 replaces one of the first 30 and takes slot 0
    expect(scheduler.slot(61)).toBe(0);
    expect(scheduler.slot(45)).toBe(scheduler.slot(15));
  });

  it("offers an agent until its review begins, then waits for the next due time, and never fires twice for one due time", () => {
    const scheduler = new ReviewScheduler(10_000, 2);
    scheduler.register(1, 0);
    scheduler.register(2, 0);
    expect(scheduler.dueAgents(9_999)).toEqual([]);
    expect(scheduler.dueAgents(10_000)).toEqual([1]);
    expect(scheduler.dueAgents(10_000)).toEqual([1]); // asking again does not use it up (a skipped review is retried)
    expect(scheduler.dueAgents(16_000)).toEqual([1, 2]);
    scheduler.begun(1, 16_000);
    expect(scheduler.dueAgents(16_000)).toEqual([2]);
    expect(scheduler.nextDue(1)).toBe(20_000); // the due time at 10 000 is used up; 20 000 is the next one after now
    scheduler.begun(1, 95_000); // a review that was late jumps over the due times that passed
    expect(scheduler.nextDue(1)).toBe(100_000);
    scheduler.forget(1);
    expect(scheduler.nextDue(1)).toBeUndefined();
    expect(scheduler.dueAgents(1e9)).toEqual([2]);
  });

  it("refuses nonsense settings", () => {
    expect(() => new ReviewScheduler(0, 3)).toThrow(RangeError);
    expect(() => new ReviewScheduler(1000, 0)).toThrow(RangeError);
  });
});

describe("AdviceBox", () => {
  it("steers into an active run at once and keeps the text for the next run when none is active", () => {
    const box = new AdviceBox();
    const seen: string[] = [];
    box.deliver("kept");
    box.attach({ steer: (text) => void seen.push(`run1:${text}`) });
    expect(seen).toEqual(["run1:kept"]);
    box.deliver("now");
    expect(seen).toEqual(["run1:kept", "run1:now"]);
    box.detach();
    box.deliver("later");
    expect(seen).toHaveLength(2);
    box.attach({ steer: (text) => void seen.push(`run2:${text}`) });
    expect(seen.at(-1)).toBe("run2:later");
  });
});

describe("BranchReviewer", () => {
  function setup(
    extra: { replies?: number; hold?: () => string | undefined; maxConcurrent?: number; outcome?: (agent: number) => ReviewOutcome; delay?: boolean } = {},
  ) {
    const clock = new FakeClock();
    const started: number[] = [];
    const results: Array<[number, ReviewOutcome["outcome"]]> = [];
    const off: string[] = [];
    const replies = new Map<number, number>();
    const release: Array<() => void> = [];
    const target = (agent: number): (ReviewTarget & { workDir: string }) | undefined =>
      agent > 40
        ? undefined
        : {
            workDir: "/w",
            replies: () => replies.get(agent) ?? extra.replies ?? 5,
            fork: async () => {},
            openReviewer: async () => ({}) as Agent,
            advise: () => {},
          };
    const reviewer = new BranchReviewer({
      everyMs: 10_000,
      ceiling: 4,
      maxTurns: 3,
      maxConcurrent: extra.maxConcurrent ?? 3,
      clock,
      dir: "/nowhere",
      target,
      holdReason: extra.hold ?? (() => undefined),
      onResult: (agent, outcome) => void results.push([agent, outcome.outcome]),
      onOff: (reason) => void off.push(reason),
      review: async (options) => {
        const agent = Number(options.forkPath.match(/\/(\d{3})-/)?.[1]);
        started.push(agent);
        if (extra.delay) await new Promise<void>((resolve) => release.push(resolve));
        return extra.outcome?.(agent) ?? { outcome: "ok", ms: 1, tokens: 10 };
      },
    });
    for (const agent of [1, 2, 3, 4]) {
      reviewer.agentStarted(agent);
      replies.set(agent, 5);
    }
    return { reviewer, clock, started, results, off, replies, release };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("starts the due reviews, each agent once per due time", async () => {
    const { reviewer, clock, started } = setup();
    await clock.advance(10_000 - clock.now());
    reviewer.check();
    await settle();
    expect(started).toEqual([1]);
    await clock.advance(25_000 - clock.now());
    reviewer.check();
    await settle();
    expect(started).toEqual([1, 2, 3, 4]); // the longest overdue first: 2, 3, 4 (then the limit of 3 at once); agent 1 is not started twice
    expect(reviewer.skips).toEqual({ limit: 1 }); // agent 1 came last (due latest) and the limit of 3 was reached
  });

  it("skips while the Gate is paused or the budget refuses, and retries at the next check", async () => {
    let hold: string | undefined = "the Gate is paused";
    const { reviewer, clock, started } = setup({ hold: () => hold });
    await clock.advance(10_000 - clock.now());
    reviewer.check();
    await settle();
    expect(started).toEqual([]);
    expect(reviewer.skips.held).toBe(1);
    hold = undefined;
    reviewer.check();
    await settle();
    expect(started).toEqual([1]);
  });

  it("never runs two reviews of one agent, and never more than the concurrency limit; the skipped ones come back", async () => {
    const { reviewer, clock, started, release, replies } = setup({ delay: true, maxConcurrent: 2 });
    await clock.advance(40_000 - clock.now());
    reviewer.check();
    await settle();
    expect(started).toEqual([1, 2]); // limit 2
    expect(reviewer.skips.limit).toBe(1);
    replies.set(1, 9);
    await clock.advance(50_000 - clock.now());
    reviewer.check();
    await settle();
    expect(started).toEqual([1, 2]); // agent 1 is still running its review; the limit still holds
    for (const done of release.splice(0)) done();
    await settle();
    reviewer.check();
    await settle();
    expect(started).toEqual([1, 2, 3, 4]);
    for (const done of release.splice(0)) done();
    await reviewer.stop();
  });

  it("does not review an agent without a new reply or without a live handle", async () => {
    const { reviewer, clock, started, replies } = setup();
    replies.set(1, 0);
    replies.set(2, 0);
    await clock.advance(30_000 - clock.now());
    reviewer.check();
    await settle();
    expect(started).toEqual([3, 4]);
    reviewer.agentStarted(99);
    reviewer.agentStarted(41);
    await clock.advance(900_000 - clock.now());
    reviewer.check();
    await settle();
    expect(reviewer.skips["not running"]).toBeGreaterThanOrEqual(1);
    reviewer.agentEnded(41);
  });

  it("switches itself off after five errors in a row, and a good review in between resets the count", async () => {
    let bad = true;
    const { reviewer, clock, results, off, replies } = setup({
      outcome: () => (bad ? { outcome: "error", ms: 1, tokens: 0, error: "boom" } : { outcome: "ok", ms: 1, tokens: 0 }),
    });
    const tick = async (time: number) => {
      await clock.advance(time - clock.now());
      for (const agent of [1, 2, 3, 4]) replies.set(agent, (replies.get(agent) ?? 0) + 1); // every agent has made a new reply
      reviewer.check();
      await settle();
    };
    await tick(100_000);
    expect(results.filter(([, kind]) => kind === "error").length).toBeLessThan(5);
    bad = false;
    await tick(200_000);
    expect(off).toEqual([]);
    bad = true;
    for (let round = 0; round < 3 && off.length === 0; round += 1) await tick(300_000 + round * 100_000);
    expect(off).toHaveLength(1);
    expect(off[0]).toContain("5 reviews failed in a row (last: boom)");
    expect(reviewer.switchedOff).toBe(true);
    const before = results.length;
    await tick(2_000_000);
    expect(results.length).toBe(before);
  });
});

describe("reviewGuard", () => {
  it("allows reading inside the agent's directory (also a file that is not there yet) and refuses everything else, absolute and relative paths alike", async () => {
    const { mkdtempSync, writeFileSync, rmSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { reviewGuard } = await import("../src/review-run.ts");
    const work = realpathSync(mkdtempSync(join(tmpdir(), "infinity-guard-")));
    writeFileSync(join(work, "a.txt"), "x");
    const handlers: Record<string, (...input: never[]) => unknown> = {};
    reviewGuard({ workDir: work, maxTurns: 3 }).setup({
      on: (hook: string, handler: never) => {
        handlers[hook] = handler;
      },
      registerTool: () => {},
      emit: () => {},
    } as never);
    const ask = async (name: string, args: unknown) =>
      (
        (await (handlers["tool.before"] as (...input: unknown[]) => Promise<{ kind: string }>)({ id: "1", name, args }, { env: { cwd: work } })) as {
          kind: string;
        }
      ).kind;
    expect(await ask("read", { path: "a.txt" })).toBe("allow");
    expect(await ask("read", { path: join(work, "a.txt") })).toBe("allow");
    expect(await ask("read", { path: "not-yet.txt" })).toBe("allow");
    expect(await ask("read", { path: "/etc/hosts" })).toBe("deny");
    expect(await ask("read", { path: "/no/such/place" })).toBe("deny");
    expect(await ask("read", { path: "../elsewhere.txt" })).toBe("deny");
    expect(await ask("read", {})).toBe("deny");
    for (const name of ["write", "edit", "bash", "submit"]) expect(await ask(name, { path: "a.txt", command: "ls" })).toBe("deny");
    rmSync(work, { recursive: true, force: true });
  });
});
