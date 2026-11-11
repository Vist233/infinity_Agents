/**
 * The first machine-learning task (docs/10 section 5): forest cover type, 7 classes, scored on hidden labels.
 *
 *   .venv-ml/bin/python examples/covertype/prepare.py 150000          # once; no argument = all 581,012 rows
 *   PATH="$PWD/.venv-ml/bin:$PATH" node examples/covertype.ts [agents] [--tokens N] [--review-minutes N] [--wall-minutes N] [resume <runDir>]
 *
 * The model key is read from OPENCODE_API_KEY and never printed. Needs Python with numpy, pandas and scikit-learn on PATH (the agents use it too).
 * Stop with Ctrl-C: the hidden labels are put back by the keeper; `examples/recover-hidden.ts <runDir>/.keeper` does it after a kill.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commandEvaluator } from "../src/evaluation.ts";
import { type RunOptions, runTask } from "../src/orchestrator.ts";
import { defineTask } from "../src/task.ts";
import { opencodeModel } from "./model.ts";

const apiKey = process.env.OPENCODE_API_KEY;
if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
delete process.env.OPENCODE_API_KEY;
const environmentModule = process.env.INFINITY_WORKER_ENVIRONMENT;
let createEnvironment: RunOptions["createEnvironment"];
if (environmentModule) {
  const configured = (await import(pathToFileURL(resolve(environmentModule)).href)).createEnvironment;
  if (typeof configured !== "function") throw new Error("The worker environment module must export createEnvironment");
  createEnvironment = configured;
}
// usage: node examples/covertype.ts [agents] [--tokens N] [--review-minutes N] [--wall-minutes N] [resume <runDir>]
const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args.splice(at, 2)[1]) : fallback;
};
const tokens = flag("tokens", 3_000_000);
const reviewMinutes = flag("review-minutes", 3);
const wallMinutes = flag("wall-minutes", 0);
const [agentsArgument, resumeWord, resumeDir] = args;
const evaluator = resolve("examples/covertype/evaluate.py");

const task = defineTask({
  name: "covertype",
  mode: "code",
  prompt:
    "Predict the forest cover type (Cover_Type, a whole number 1 to 7) of the rows in data/test_features.csv. data/train.csv has the same features and the label column Cover_Type; " +
    "use it for training and for your own validation. Write your predictions to predictions.csv: one column named Cover_Type, one row per row of test_features.csv, in the same order. " +
    "Choose your own model, features and training procedure. Use bash to run your code and use any accelerator available to that command. " +
    "Submit the command that produced your result, predictions.csv, and the training code. The score is accuracy on hidden labels. " +
    "The machine is shared by many agents: use at most 2 threads per training process, about 3 GB of memory per process, and at most 10 minutes per command. " +
    "Do not download the original public covertype data set (fetch_covtype, UCI files) or look up test rows in it: that would be cheating, and it is refused.",
  files: { data: resolve("data/covertype") },
  hidden: [resolve("data/covertype-labels")],
  protect: [evaluator],
  evaluate: commandEvaluator({ file: process.env.INFINITY_PYTHON ?? "python3", args: [evaluator], timeoutMs: 5 * 60_000 }),
  metric: { name: "accuracy", direction: "max" },
  review: {
    policy: {
      hard_deny: [
        "Downloading or reading the original public covertype data set (fetch_covtype, UCI covertype files, Kaggle copies) to find the labels of the test rows.",
      ],
    },
  },
  branchReview: { everyMinutes: reviewMinutes, maxTurns: 6, maxConcurrent: 2 },
  agents: Number(agentsArgument ?? 3),
  model: opencodeModel(apiKey),
  stop: "until-stopped",
  tokens,
  stuckMinutes: 15,
  submitIntervalMinutes: 2,
  evalSlots: 1,
  runsDir: "runs",
});

// Ctrl-C ends the run in order (agents stopped, report written). The keeper's own exit guard also puts the hidden labels back at once on that signal, so an evaluation
// that is running at that moment may fail; the run ends in a few seconds anyway. The handler stays registered (the guard sends the signal again).
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
if (wallMinutes > 0) setTimeout(() => stop.abort(), wallMinutes * 60_000).unref(); // a wall-clock cap ends the run in order, like Ctrl-C
const outcome = await runTask(task, {
  signal: stop.signal,
  ...(createEnvironment ? { createEnvironment } : {}),
  ...(resumeWord === "resume" && resumeDir ? { resume: true, runDir: resumeDir } : {}),
});
console.log(JSON.stringify(outcome));
