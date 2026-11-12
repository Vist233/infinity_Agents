import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_MINUTES, reviewFlags, takeNumber, takeSwitch } from "../examples/capacity-flags.ts";

describe("flags of the examples", () => {
  it("takes a number and a switch out of the argument list and leaves the rest", () => {
    const args = ["3", "--tokens", "500", "--no-gate", "resume", "dir"];
    expect(takeNumber(args, "tokens")).toBe(500);
    expect(takeSwitch(args, "no-gate")).toBe(true);
    expect(takeSwitch(args, "no-gate")).toBe(false);
    expect(takeNumber(args, "tokens")).toBeUndefined();
    expect(args).toEqual(["3", "resume", "dir"]);
    expect(() => takeNumber(["--tokens", "many"], "tokens")).toThrow("--tokens needs a number");
  });
});

describe("--no-review and --review-minutes", () => {
  it("the default is a branch review every few minutes, and --review-minutes sets the time", () => {
    expect(reviewFlags([])).toEqual({ branchReview: { everyMinutes: DEFAULT_REVIEW_MINUTES, maxTurns: 6, maxConcurrent: 2 }, notes: [] });
    expect(reviewFlags(["--review-minutes", "7"]).branchReview?.everyMinutes).toBe(7);
  });

  it("--no-review leaves branchReview out of the task, says so in a note for the report, and is taken out of the arguments", () => {
    const args = ["--agents", "16", "--no-review", "resume", "dir"];
    const result = reviewFlags(args);
    expect("branchReview" in result).toBe(false);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("Branch review: off");
    expect(args).toEqual(["--agents", "16", "resume", "dir"]);
    // the way the example puts it into the task
    const task = { name: "x", ...(result.branchReview ? { branchReview: result.branchReview } : {}) };
    expect(Object.keys(task)).toEqual(["name"]);
  });

  it("--no-review together with --review-minutes is an error, in either order", () => {
    expect(() => reviewFlags(["--no-review", "--review-minutes", "5"])).toThrow("--no-review cannot be used with --review-minutes");
    expect(() => reviewFlags(["--review-minutes", "5", "--no-review"])).toThrow("--no-review cannot be used with --review-minutes");
  });
});
