/**
 * A dry run with scripted agents (no model, no key): how much memory and time does the orchestrator itself need for N agents on this machine?
 *
 *   node examples/dry-run.ts [agents] [seconds] [latencyMs]      (default: 30 agents, 90 seconds, 300 ms per reply)
 *
 * Prints the peak resident memory of this process, the load average and how many agents were alive when it ended. Leaves nothing behind.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/orchestrator.ts";
import { loadState } from "../src/run-state.ts";
import { defineTask } from "../src/task.ts";
import { createScriptedCodeModel } from "../test/support/scripted-code-model.ts";

const [agentsArgument, secondsArgument, latencyArgument] = process.argv.slice(2);
const agents = Number(agentsArgument ?? 30);
const seconds = Number(secondsArgument ?? 90);
const root = mkdtempSync(join(process.cwd(), "runs", ".dry-"));
const model = createScriptedCodeModel({ hints: ["a", "b", "c", "d"], value: (_hint, cycle) => cycle, latencyMs: Number(latencyArgument ?? 300) });
const task = defineTask({
  name: "dry run",
  mode: "code",
  prompt: "Raise the number in pred.txt.",
  evaluate: async ({ workDir }) => ({ status: "ok", score: Number(readFileSync(join(workDir, "pred.txt"), "utf8")) / 100, metrics: {}, details: "" }),
  metric: { name: "score", direction: "max" },
  review: false,
  branchReview: { everyMinutes: 0.2, maxTurns: 3, maxConcurrent: 3 },
  agents,
  model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
  stop: "until-stopped",
  runsDir: root,
});
let peakRss = 0;
let peakLoad = 0;
let peakLive = 0;
const runDir = join(root, "run");
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  peakLoad = Math.max(peakLoad, loadavg()[0] ?? 0);
  peakLive = Math.max(peakLive, Object.keys(loadState(join(runDir, "state.json"))?.ladder.live ?? {}).length);
}, 2000);
const stop = new AbortController();
setTimeout(() => stop.abort(), seconds * 1000);
const started = Date.now();
const outcome = await runTask(task, { createClient: () => model, runDir, signal: stop.signal, checkEveryMs: 1000 });
clearInterval(sampler);
console.log(
  JSON.stringify({
    agents,
    seconds: Math.round((Date.now() - started) / 1000),
    ended: outcome.reason,
    peakLive,
    peakRssMb: Math.round(peakRss / 1e6),
    peakLoad1m: Math.round(peakLoad * 10) / 10,
    requests: model.requestCount,
  }),
);
rmSync(root, { recursive: true, force: true });
