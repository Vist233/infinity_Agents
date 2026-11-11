/** Run by a test as a separate process, so that the test can kill it: node child-code-run.ts <runDir> <runsDir>. Code agents with the branch review on; nobody reaches a target. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../../src/orchestrator.ts";
import { defineTask } from "../../src/task.ts";
import { createScriptedCodeModel } from "./scripted-code-model.ts";

const [runDir, runsDir] = process.argv.slice(2);
const model = createScriptedCodeModel({ hints: ["h1", "h2", "h3", "h4"], value: (_hint, cycle) => cycle, latencyMs: 20 });
const task = defineTask({
  name: "kill test",
  mode: "code",
  prompt: "Raise the number in pred.txt.",
  evaluate: async (context) => ({ status: "ok", score: Number(readFileSync(join(context.workDir, "pred.txt"), "utf8")) / 100, metrics: {}, details: "" }),
  metric: { name: "score", direction: "max" },
  review: false,
  branchReview: { everyMinutes: 0.004, maxTurns: 3, maxConcurrent: 2 },
  agents: 4,
  model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
  stop: "until-stopped",
  runsDir: runsDir ?? ".",
});
await runTask(task, { createClient: () => model, runDir: runDir ?? "run", checkEveryMs: 50 });
