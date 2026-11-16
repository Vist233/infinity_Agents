import { describe, expect, it } from "vitest";
import { loadTaskPackage } from "../bin/infinity.ts";
import { STATEMENTS, mathPackage } from "../tasks/math-task.ts";

const model = { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 };

describe("the math task packages", () => {
  it.each(Object.keys(STATEMENTS))("`infinity run math-%s` finds a package that builds a first-success math task", async (name) => {
    const pack = await loadTaskPackage(`math-${name}`);
    expect(pack.name).toBe(`math-${name}`);
    const task = pack.build({ agents: 3, profile: {}, model, tokens: undefined, branchReview: undefined, commandMinutes: undefined, runsDir: "runs" });
    expect(task.mode).toBe("math");
    expect(task.agents).toBe(3);
    expect(task.stop).toBe("first-success");
    if (task.mode !== "math") throw new Error("not a math task");
    expect(task.statement).toBe(STATEMENTS[name as keyof typeof STATEMENTS]);
  });

  it("passes the caller's token budget on and uses the package default otherwise", () => {
    const context = { agents: 1, profile: {}, model, branchReview: undefined, commandMinutes: undefined, runsDir: "runs" };
    expect(mathPackage("parity").build({ ...context, tokens: 1234 }).tokens).toBe(1234);
    expect(mathPackage("parity").defaults?.tokens).toBe(3_000_000);
  });
});
