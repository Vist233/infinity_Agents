/** Run by a test as a separate process, so that the test can kill it: node child-run.ts <runDir> <runsDir>. Nobody ever proves. */
import { runTask } from "../../src/orchestrator.ts";
import { defineTask } from "../../src/task.ts";
import { fakeVerifier } from "./fake-verifier.ts";
import { mathModeWith } from "./math-mode-with.ts";
import { createScriptedModel } from "./scripted-model.ts";

const [runDir, runsDir] = process.argv.slice(2);
const model = createScriptedModel({ hints: ["h1", "h2", "h3", "h4"], isGood: () => false, latencyMs: 5 });
const task = defineTask({
  name: "kill test",
  mode: "math",
  statement: "True",
  agents: 4,
  model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
  stop: "first-success",
  runsDir: runsDir ?? ".",
});
await runTask(task, { createClient: () => model, mode: mathModeWith({ verifier: fakeVerifier }), runDir: runDir ?? "run", checkEveryMs: 50 });
