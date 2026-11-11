import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget.ts";

const reply = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0 });

describe("Budget", () => {
  it("never stops without a limit", () => {
    const budget = new Budget(undefined, () => 100);
    budget.record(reply(1_000_000, 1_000_000));
    expect(budget.refusal()).toBeUndefined();
  });

  it("counts cache reads in full", () => {
    const budget = new Budget(10_000, () => 0);
    budget.record(reply(100, 50, 850));
    expect(budget.tokensUsed).toBe(1000);
    expect(budget.meanRequestTokens).toBe(1000);
  });

  it("allows a request while used plus the in-flight margin stays below the limit", () => {
    const budget = new Budget(1000, () => 0);
    budget.record(reply(200, 100)); // mean 300, used 300
    expect(budget.refusal()).toBeUndefined(); // 300 + 1 x 300 = 600 < 1000
  });

  it("refuses when used + inflight x mean reaches the limit", () => {
    let inflight = 0;
    const budget = new Budget(1000, () => inflight);
    budget.record(reply(200, 100));
    budget.record(reply(200, 100)); // used 600, mean 300
    expect(budget.refusal()).toBeUndefined(); // 600 + 1 x 300 = 900
    inflight = 1;
    expect(budget.refusal()).toContain("token budget reached"); // 600 + 2 x 300 = 1200
  });

  it("with two in flight it is the owner's rule: used + 2 x mean >= budget", () => {
    const budget = new Budget(900, () => 1); // the candidate makes two
    budget.record(reply(200, 100));
    budget.record(reply(200, 100)); // 600 + 600 = 1200 >= 900
    expect(budget.refusal()).toBeDefined();
  });

  it("refuses a new request once used alone is over the limit", () => {
    const budget = new Budget(100, () => 0);
    budget.record(reply(80, 40));
    expect(budget.refusal()).toBeDefined();
  });

  it("takes up the totals again after a restart", () => {
    const budget = new Budget(1000, () => 0);
    budget.restore(600, 2);
    expect(budget.tokensUsed).toBe(600);
    expect(budget.requestCount).toBe(2);
    expect(budget.refusal()).toBeUndefined(); // 600 + 1 x 300 < 1000
    budget.restore(800, 2);
    expect(budget.refusal()).toBeDefined(); // 800 + 1 x 400 >= 1000
  });

  it("rejects a non-positive limit", () => {
    expect(() => new Budget(0, () => 0)).toThrow(RangeError);
  });
});
