import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComponentContext, RunComponent } from "../src/component.ts";
import { JsonlFile } from "../src/jsonl.ts";
import { runTask } from "../src/orchestrator.ts";
import type { RunEvent } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { defineTask } from "../src/task.ts";
import { createFakeEvaluator } from "./support/fake-evaluator.ts";
import { createScriptedCodeModel } from "./support/scripted-code-model.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "infinity-brake-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a run with a component that holds the ladder", () => {
  it("stays at one agent while held, however many replies come in, and climbs once the hold is off", async () => {
    writeFileSync(join(dir, "truth.txt"), "100");
    const model = createScriptedCodeModel({ hints: ["h1", "h2", "h3", "h4"], value: (hint, cycle) => Number(hint.slice(1)) * 10 + cycle, latencyMs: 5 });
    const task = defineTask({
      name: "brake",
      mode: "code",
      prompt: "p",
      hidden: [join(dir, "truth.txt")],
      evaluate: createFakeEvaluator({ original: join(dir, "truth.txt") }).evaluate,
      metric: { name: "score", direction: "max" },
      review: false,
      agents: 4,
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: "until-stopped",
      runsDir: dir,
    });
    let hold: ComponentContext["hold"] = () => {};
    const component: RunComponent = {
      name: "test-brake",
      start(context) {
        hold = context.hold;
        context.hold(true);
      },
      async stop() {},
    };
    const layout = runLayout(join(dir, "run"));
    const controller = new AbortController();
    const events = () => (existsSync(layout.events) ? new JsonlFile<RunEvent>(layout.events).readAll() : []);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const running = runTask(task, { createClient: () => model, runDir: layout.root, signal: controller.signal, components: [component] });
    await wait(1500);
    const repliesWhileHeld = model.agentRequests.length;
    expect(repliesWhileHeld).toBeGreaterThan(6); // plenty of replies: without the hold the ladder would have climbed
    expect(events().filter((event) => event.type === "rung")).toEqual([]);
    hold(false);
    for (let waited = 0; waited < 10_000 && !events().some((event) => event.type === "rung"); waited += 50) await wait(50);
    controller.abort();
    await running;
    expect(events().some((event) => event.type === "rung")).toBe(true);
  }, 30_000);
});
