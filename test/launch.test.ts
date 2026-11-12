import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TaskPackage, launchProblems, readRunEvents, readRunStatus, startRun } from "../src/launch.ts";
import { createInfinityTools } from "../src/sakura-tools.ts";
import { defineTask } from "../src/task.ts";
import { createFakeEvaluator } from "./support/fake-evaluator.ts";
import { createScriptedCodeModel } from "./support/scripted-code-model.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "infinity-launch-")));
  writeFileSync(join(dir, "truth.txt"), "100");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const model = { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 };
const scripted = () => createScriptedCodeModel({ hints: ["h1"], value: (_hint, cycle) => 40 + 30 * cycle });

/** A task package of the kind a user writes: a name, a profile, and how to build the task from the caller's choices. */
const smallPackage = (seen: { context?: unknown } = {}): TaskPackage => ({
  name: "small",
  summary: "a scripted task",
  profile: { cpu: { threadsPerJob: 2 } },
  defaults: { tokens: 1_000_000 },
  build(context) {
    seen.context = context;
    return defineTask({
      name: "small",
      mode: "code",
      prompt: "p",
      hidden: [join(dir, "truth.txt")],
      evaluate: createFakeEvaluator({ original: join(dir, "truth.txt") }).evaluate,
      metric: { name: "score", direction: "max" },
      review: false,
      agents: context.agents,
      model: context.model,
      profile: context.profile,
      stop: { targetScore: 0.9 },
      runsDir: context.runsDir,
      ...(context.tokens === undefined ? {} : { tokens: context.tokens }),
    });
  },
});

describe("launch options", () => {
  it("are checked before anything starts", () => {
    expect(launchProblems({ model })).toEqual([]);
    expect(launchProblems({ model, agents: 0 })[0]).toContain("agents must be a whole number");
    expect(launchProblems({ model, tokens: -1 })).toEqual(["tokens must be a number above 0"]);
    expect(launchProblems({ model, heavyShare: 2 })).toEqual(["heavyShare is a share: 1 at most"]);
    expect(launchProblems({ model, gate: 0 })).toEqual(["gate slots must be a whole number of 1 or more"]);
  });
});

describe("startRun", () => {
  it("refuses bad options with a clear message and starts nothing", async () => {
    await expect(startRun(smallPackage(), { model, agents: 0, runsDir: dir })).rejects.toThrow("agents must be a whole number");
  });

  it("returns a handle at once: the caller's agents win, the package gets the choices, status and events read the files, done gives the outcome", async () => {
    const seen: { context?: { agents: number; tokens: number | undefined; profile: { cpu?: { threadsPerJob?: number } } } } = {};
    const handle = await startRun(smallPackage(seen), {
      model,
      agents: 1,
      threads: 3,
      runsDir: dir,
      review: false,
      commandLine: ["small", "--agents", "1"],
      testing: { createClient: scripted },
    });
    expect(handle.agents).toBe(1);
    expect(handle.recommendation.lines[0]).toContain("you asked for 1");
    expect(seen.context?.agents).toBe(1);
    expect(seen.context?.tokens).toBe(1_000_000);
    expect(seen.context?.profile.cpu?.threadsPerJob).toBe(3);
    expect(handle.runDir.startsWith(dir)).toBe(true);
    const outcome = await handle.done;
    expect(outcome.runDir).toBe(handle.runDir);
    const facts = JSON.parse(readFileSync(join(handle.runDir, "run-facts.json"), "utf8"));
    expect(facts.commandLine).toEqual(["small", "--agents", "1"]);
    expect(facts.gate.enabled).toBe(true);
    const status = handle.status();
    expect(status).toMatchObject({ task: "small", state: "finished", reason: outcome.reason });
    expect(status.results).toBeGreaterThan(0);
    const { events, next } = handle.events();
    expect(events.some((event) => event.type === "run_start")).toBe(true);
    expect(events.at(-1)?.type).toBe("run_end");
    expect(handle.events(next).events).toEqual([]);
    expect(readRunStatus(handle.runDir)).toEqual(status);
    expect(readRunEvents(handle.runDir).next).toBe(next);
  }, 60_000);

  it("stop() ends a run in order and gives the outcome", async () => {
    const forever = createScriptedCodeModel({ hints: ["h1"], value: () => 10 });
    const handle = await startRun(smallPackage(), { model, agents: 1, runsDir: dir, review: false, testing: { createClient: () => forever } });
    const outcome = await handle.stop();
    expect(outcome.runDir).toBe(handle.runDir);
    expect(handle.status().state).toBe("finished");
  }, 60_000);
});

describe("run status", () => {
  it("an empty directory is empty, and a run with no end and no recent change is stopped", () => {
    expect(readRunStatus(join(dir, "nothing")).state).toBe("empty");
  });
});

describe("the Sakura tools", () => {
  it("start a run by name, report on it from the files and stop it", async () => {
    const tools = createInfinityTools({ packs: [smallPackage()], model, defaults: { runsDir: dir, testing: { createClient: scripted } } });
    expect(tools.map((tool) => tool.name)).toEqual(["infinity_run", "infinity_status", "infinity_stop"]);
    const [run, status, stop] = tools as [(typeof tools)[number], (typeof tools)[number], (typeof tools)[number]];
    const context = { signal: new AbortController().signal } as never;
    const bad = await run.execute({ task: "nope" }, context);
    expect(bad.isError).toBe(true);
    const started = await run.execute({ task: "small", agents: 1, review: false }, context);
    expect(started.isError).toBeUndefined();
    const read = async () => JSON.parse(((await status.execute({}, context)).content[0] as { text: string }).text);
    const first = await read();
    expect(first.runDir.startsWith(dir)).toBe(true);
    expect(["empty", "running", "finished"]).toContain(first.state);
    const ended = await stop.execute({}, context);
    expect(ended.isError).toBeUndefined();
    const after = await read();
    expect(after.state).toBe("finished");
    expect((await stop.execute({ runDir: "/elsewhere" }, context)).isError).toBe(true);
  }, 60_000);
});
