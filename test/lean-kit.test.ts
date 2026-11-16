import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realClock } from "../src/clock.ts";
import { leanKit } from "../src/lean-kit.ts";
import { createMode } from "../src/mode-factory.ts";
import type { ScoreFn } from "../src/mode.ts";
import { runLayout } from "../src/run-layout.ts";
import { defineTask } from "../src/task.ts";
import { FakeLeanRunner } from "./support/fake-lean-runner.ts";
import { fakeVerifier } from "./support/fake-verifier.ts";
import { createScriptedModel } from "./support/scripted-model.ts";

const tools = { kind: "lean", statement: "1 = 1" } as const;
const unusedScore: ScoreFn = async () => {
  throw new Error("a proof task does not use the evaluator");
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-kit-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the Lean kit", () => {
  it("cannot set up agents before it is prepared", () => {
    expect(() => leanKit({ tools, leanDir: root }).agentSetup({ hint: "h", agent: 1, links: {}, score: unusedScore })).toThrow("prepared");
  });

  it("prepares by compiling the statement with the runner it is given, once", async () => {
    const runner = new FakeLeanRunner();
    const kit = leanKit({ tools, leanDir: join(root, "lean"), leanRunner: runner });
    await kit.prepare();
    expect(runner.requests[0]?.args).toEqual(["-o", "Statement.olean", "Statement.lean"]);
    expect(readFileSync(join(root, "lean", "Statement.lean"), "utf8")).toContain("abbrev Goal : Prop := 1 = 1");
    await kit.prepare();
    expect(runner.requests).toHaveLength(1);
  });

  it("does nothing in prepare when a verifier is given, and tells the planner to plan proofs of the statement", async () => {
    const kit = leanKit({ tools, leanDir: root, verifier: fakeVerifier });
    await kit.prepare();
    expect(kit.plannerSubject).toBe("1 = 1");
    expect(kit.plannerKind).toBe("math");
    expect(kit.warnings()).toEqual([]);
  });

  it("sets up a confined agent with file tools only and the statement in its directory", () => {
    const setup = leanKit({ tools, prompt: "be brief", leanDir: root, verifier: fakeVerifier }).agentSetup({
      hint: "try omega",
      agent: 1,
      links: {},
      score: unusedScore,
    });
    expect(setup.confine).toBe(true);
    expect(setup.builtinTools).toEqual(["read", "write"]);
    expect(setup.prompt).toContain("be brief");
    expect(setup.rules.at(-1)).toContain("try omega");
    expect(setup.files["Statement.lean"]).toContain("namespace Statement");
  });

  it("gives the agent one extra tool, lean, whose submit reaches the worker as a scored submission", async () => {
    const received: unknown[] = [];
    const setup = leanKit({ tools, leanDir: root, verifier: fakeVerifier }).agentSetup({ hint: "h", agent: 1, links: {}, score: unusedScore });
    const [lean, ...others] = setup.tools(async (submission) => void received.push(submission), { commitNow: async () => null, workDir: "." });
    expect(others).toEqual([]);
    expect(lean?.name).toBe("lean");
    const env = { readFile: async () => new TextEncoder().encode("GOOD") };
    await lean?.execute({ action: "submit" }, { env, signal: new AbortController().signal } as unknown as ToolContext);
    expect(received).toMatchObject([{ command: "lean submit Proof.lean", entry: "GOOD", result: { status: "ok", score: 1 }, selfReported: false }]);
  });
});

describe("createMode", () => {
  const context = (task: ReturnType<typeof defineTask>) => ({
    task,
    layout: runLayout(root),
    clock: realClock,
    clientFor: () => createScriptedModel({ hints: [], isGood: () => false }),
  });
  const model = { baseUrl: "x", apiKey: "x", model: "x", contextWindow: 1 };

  it("builds a mode with the Lean kit for a proof task", () => {
    const mode = createMode(context(defineTask({ name: "m", tools, agents: 2, model })));
    expect(mode.plannerKind).toBe("math");
    expect(mode.plannerSubject).toContain("1 = 1");
  });

  it("builds a mode with the shell kit for a program task", () => {
    const mode = createMode(context(defineTask({ name: "c", prompt: "make it fast", review: false, agents: 2, model })));
    expect(mode.plannerKind).toBe("code");
    expect(mode.plannerSubject).toBe("make it fast");
    expect(mode.warnings?.().join(" ")).toContain("safety review is OFF");
  });
});
