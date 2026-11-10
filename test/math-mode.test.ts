import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MathMode } from "../src/math-mode.ts";
import { createMode } from "../src/mode-factory.ts";
import { runLayout } from "../src/run-layout.ts";
import { defineTask } from "../src/task.ts";
import { FakeLeanRunner } from "./support/fake-lean-runner.ts";
import { fakeVerifier } from "./support/fake-verifier.ts";

const task = defineTask({
  name: "m",
  mode: "math",
  statement: "1 = 1",
  prompt: "be brief",
  agents: 2,
  model: { baseUrl: "x", apiKey: "x", model: "x", contextWindow: 1 },
  stop: "first-success",
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-mode-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("MathMode", () => {
  it("cannot set up agents before it is prepared", () => {
    expect(() => new MathMode({ task, leanDir: root }).agentSetup("h")).toThrow("prepare()");
  });

  it("prepares by compiling the statement with the runner it is given", async () => {
    const runner = new FakeLeanRunner();
    const mode = new MathMode({ task, leanDir: join(root, "lean"), leanRunner: runner });
    await mode.prepare();
    expect(runner.requests[0]?.args).toEqual(["-o", "Statement.olean", "Statement.lean"]);
    expect(readFileSync(join(root, "lean", "Statement.lean"), "utf8")).toContain("abbrev Goal : Prop := 1 = 1");
    await mode.prepare(); // a second call does not compile again
    expect(runner.requests).toHaveLength(1);
  });

  it("does nothing in prepare when a verifier is given", async () => {
    const mode = new MathMode({ task, leanDir: root, verifier: fakeVerifier });
    await mode.prepare();
    expect(mode.plannerSubject).toBe("1 = 1");
  });

  it("sets up a confined agent with a goal tied to the proved marker and the statement in its directory", () => {
    const setup = new MathMode({ task, leanDir: root, verifier: fakeVerifier }).agentSetup("try omega");
    expect(setup.goal.verify).toBe("test -f ../proved");
    expect(setup.confine).toBe(true);
    expect(setup.builtinTools).toEqual(["read", "write"]);
    expect(setup.prompt).toContain("be brief");
    expect(setup.rules.at(-1)).toContain("try omega");
    expect(setup.files["Statement.lean"]).toContain("namespace Statement");
  });

  it("gives the agent one extra tool, lean, whose submit reaches the worker", async () => {
    const received: unknown[] = [];
    const setup = new MathMode({ task, leanDir: root, verifier: fakeVerifier }).agentSetup("h");
    const [lean, ...others] = setup.tools(async (submission) => void received.push(submission));
    expect(others).toEqual([]);
    expect(lean?.name).toBe("lean");
    const env = { readFile: async () => new TextEncoder().encode("GOOD") };
    await lean?.execute({ action: "submit" }, { env, signal: new AbortController().signal } as unknown as ToolContext);
    expect(received).toEqual([{ code: "GOOD", verdict: { proved: true, reason: "proved" } }]);
  });
});

describe("createMode", () => {
  it("builds the math mode for a math task, with the overrides it is given", async () => {
    const mode = createMode(task, runLayout(root), { verifier: fakeVerifier });
    expect(mode.name).toBe("math");
    await mode.prepare();
    expect(mode.agentSetup("h").prompt).toContain("1 = 1");
  });
});
