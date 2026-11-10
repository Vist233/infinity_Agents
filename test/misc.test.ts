import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEAN_INSTALL_COMMAND, findLean } from "../src/lean-setup.ts";
import { defaultLeanPoolSize } from "../src/pool.ts";
import { MATH_RULES, strategyRule, taskPrompt } from "../src/prompts.ts";
import { loadState, saveState } from "../src/run-state.ts";
import { startLadder } from "../src/ladder.ts";
import { defineTask } from "../src/task.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-misc-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("run state", () => {
  const state = {
    version: 1 as const,
    task: "t",
    startedAt: 5,
    hints: ["h"],
    ladder: startLadder(4).state,
    proved: [],
    tokensUsed: 10,
    requests: 2,
    failures: 0,
    finished: null,
  };
  it("is saved and loaded back unchanged", () => {
    saveState(join(root, "state.json"), state);
    expect(loadState(join(root, "state.json"))).toEqual(state);
  });
  it("is absent, unreadable or of another version: nothing to resume", () => {
    expect(loadState(join(root, "none.json"))).toBeUndefined();
    writeFileSync(join(root, "bad.json"), "{broken");
    expect(loadState(join(root, "bad.json"))).toBeUndefined();
    writeFileSync(join(root, "old.json"), '{"version": 0}');
    expect(loadState(join(root, "old.json"))).toBeUndefined();
  });
});

describe("findLean", () => {
  it("stops with the install command when lean is not there", async () => {
    const path = process.env.PATH;
    process.env.PATH = root;
    try {
      await expect(findLean()).rejects.toThrow(LEAN_INSTALL_COMMAND);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("defineTask", () => {
  const base = {
    name: "t",
    mode: "math" as const,
    statement: "True",
    agents: 2,
    model: { baseUrl: "x", apiKey: "k", model: "m", contextWindow: 1 },
    stop: "first-success" as const,
  };
  it("accepts a good task and returns it", () => {
    expect(defineTask(base)).toBe(base);
  });
  it.each([
    [{ name: " " }, "name must not be empty"],
    [{ agents: 101 }, "agents must be"],
    [{ agents: 1.5 }, "agents must be"],
    [{ tokens: 0 }, "tokens must be positive"],
    [{ leanPool: 0 }, "leanPool must be at least 1"],
    [{ stuckMinutes: -1 }, "stuckMinutes must be positive"],
  ])("rejects %j", (change, message) => {
    expect(() => defineTask({ ...base, ...change })).toThrow(message);
  });
  it("lists every problem at once", () => {
    expect(() => defineTask({ ...base, name: "", agents: 0 })).toThrow(/name must not be empty; agents must be/);
  });
});

describe("prompts and pool size", () => {
  it("tells the agent the statement, the author's notes and its hint", () => {
    expect(taskPrompt("True", "be brief")).toContain("be brief");
    expect(taskPrompt("True", undefined)).not.toContain("Notes from the task author");
    expect(strategyRule("use omega")).toContain("use omega");
    expect(MATH_RULES.join(" ")).toContain("import Statement");
  });
  it("uses the CPU core count for the Lean pool, at least one", () => {
    expect(defaultLeanPoolSize(8)).toBe(8);
    expect(defaultLeanPoolSize(0)).toBe(1);
  });
});
