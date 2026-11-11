/** Run by a test: node child-sigint-run.ts <runDir> <runsDir> <hiddenFile>. A code run that ends in order on SIGINT, like examples/covertype.ts. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../../src/orchestrator.ts";
import { defineTask } from "../../src/task.ts";
import { createScriptedCodeModel } from "./scripted-code-model.ts";

const [runDir, runsDir, hidden] = process.argv.slice(2);
const model = createScriptedCodeModel({ hints: ["h1", "h2"], value: (_hint, cycle) => cycle, latencyMs: 20 });
const task = defineTask({
  name: "sigint test",
  mode: "code",
  prompt: "Raise the number in pred.txt.",
  hidden: [hidden as string],
  evaluate: async (context) => ({ status: "ok", score: Number(readFileSync(join(context.workDir, "pred.txt"), "utf8")) / 100, metrics: {}, details: "" }),
  metric: { name: "score", direction: "max" },
  review: false,
  agents: 2,
  model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
  stop: "until-stopped",
  runsDir: runsDir ?? ".",
});
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
console.log("ready");
const outcome = await runTask(task, { createClient: () => model, runDir: runDir ?? "run", checkEveryMs: 50, signal: stop.signal });
console.log(JSON.stringify(outcome.reason));
