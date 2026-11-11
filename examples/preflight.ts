/**
 * Checks everything a real covertype run needs, before it starts (docs/10 section 10.1, docs/11-runbook.md).
 *
 *   node examples/preflight.ts [--min-cores 16] [--min-free-gb 64] [--min-disk-gb 10] [--cache-floor 0.6] [--dry-seconds 60] [--offline]
 *
 * One line per check; the first failure ends it with exit code 1. Prints versions, counts and sizes, never the key and never the environment
 * (the key is reported only as "set"). `--offline` skips the two checks that call the model. Real model calls: one tiny request and a short probe session (about 15 requests).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, freemem, tmpdir, totalmem } from "node:os";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type Event, type LlmClient, type LlmEvent, type LlmRequest, type Plugin, corePlugins, createAgent, createChatClient } from "sakura-agent";
import { commandEvaluator } from "../src/evaluation.ts";
import { HiddenKeeper } from "../src/hidden-keeper.ts";
import { CONNECT_ATTEMPT_TIMEOUT_MS, allowSlowConnects } from "../src/network.ts";
import { runTask } from "../src/orchestrator.ts";
import { reviewGuard } from "../src/review-run.ts";
import { parseReviewSnapshot, readReviewEvidence, reviewQuestion } from "../src/review-snapshot.ts";
import { defineTask } from "../src/task.ts";
import { createScriptedCodeModel } from "../test/support/scripted-code-model.ts";
import { opencodeModel } from "./model.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const minCores = option("min-cores", 16);
const minFreeGb = option("min-free-gb", 64);
const minDiskGb = option("min-disk-gb", 10);
const cacheFloor = option("cache-floor", 0.6);
const drySeconds = option("dry-seconds", 60);
const offline = args.includes("--offline");
const python = process.env.INFINITY_PYTHON ?? "python3";
const GB = 1024 ** 3;

let step = 0;
function report(name: string, detail: string): void {
  step += 1;
  console.log(`${String(step).padStart(2)} ok   ${name}: ${detail}`);
}
function fail(name: string, detail: string): never {
  step += 1;
  console.log(`${String(step).padStart(2)} FAIL ${name}: ${detail}`);
  process.exit(1);
}
async function versionOf(command: string, commandArgs: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(command, commandArgs, { timeout: 30_000 });
    return (stdout || stderr).trim().split("\n")[0] ?? "";
  } catch {
    return "";
  }
}

// ---- 1. tools -------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) fail("node", `${process.version}; version 24 or newer is needed (it runs TypeScript directly)`);
report("node", process.version);
const git = await versionOf("git", ["--version"]);
if (!git) fail("git", "not found on PATH");
report("git", git);
const libraries = await versionOf(python, [
  "-c",
  "import numpy, pandas, sklearn; print('numpy', numpy.__version__, 'pandas', pandas.__version__, 'scikit-learn', sklearn.__version__)",
]);
if (!libraries) fail("python", `${python} cannot import numpy, pandas and scikit-learn (set INFINITY_PYTHON, or install them)`);
report("python libraries", `${await versionOf(python, ["--version"])}; ${libraries}`);
const framework = JSON.parse(readFileSync(resolve("node_modules/sakura-agent/package.json"), "utf8")) as { version: string };
report("sakura-agent", framework.version);

// ---- 2. machine -----------------------------------------------------------
const cores = cpus().length;
const freeGb = freemem() / GB;
report(
  "machine",
  `${cores} cores, ${freeGb.toFixed(1)} GB free of ${(totalmem() / GB).toFixed(1)} GB (the free figure of macOS is misleading; the check is meant for Linux)`,
);
if (cores < minCores) fail("cores", `${cores} cores; this run needs at least ${minCores} (override with --min-cores)`);
if (freeGb < minFreeGb) fail("free memory", `${freeGb.toFixed(1)} GB free; this run needs at least ${minFreeGb} GB (override with --min-free-gb)`);
const runs = resolve("runs");
mkdirSync(runs, { recursive: true });
const disk = statfsSync(runs);
const freeDiskGb = (disk.bavail * disk.bsize) / GB;
if (freeDiskGb < minDiskGb) fail("disk", `${freeDiskGb.toFixed(1)} GB free where runs/ is; at least ${minDiskGb} GB are needed (--min-disk-gb)`);
report("disk", `${freeDiskGb.toFixed(1)} GB free where runs/ is`);
const gpu = await versionOf("nvidia-smi", ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader"]);
report("gpu", gpu ? `nvidia-smi lists: ${gpu}` : "none listed (covertype does not use one)");

// ---- 3. data --------------------------------------------------------------
const files = ["data/covertype/train.csv", "data/covertype/test_features.csv", "data/covertype-labels/test_labels.csv"].map((path) => resolve(path));
for (const file of files) if (!existsSync(file)) fail("data", `${file} is missing (run examples/covertype/prepare.py)`);
const labelsDir = resolve("data/covertype-labels");
const rows = (path: string) => readFileSync(path, "utf8").split("\n").length - 2;
report(
  "data",
  `train ${rows(files[0] as string)} rows, test ${rows(files[1] as string)} rows, ${rows(files[2] as string)} hidden labels, on the filesystem of runs/`,
);

// ---- 4. the evaluator -----------------------------------------------------
const evaluator = commandEvaluator({ file: python, args: [resolve("examples/covertype/evaluate.py")], timeoutMs: 120_000 });
const labels = readFileSync(files[2] as string, "utf8")
  .trim()
  .split("\n")
  .slice(1);
const scratch = mkdtempSync(join(tmpdir(), "infinity-preflight-"));
const score = async (lines: string[]) => {
  writeFileSync(join(scratch, "predictions.csv"), `${lines.join("\n")}\n`);
  return evaluator({ workDir: scratch, commit: null, command: "preflight", files: [], hidden: [labelsDir], signal: new AbortController().signal });
};
const perfect = await score(["Cover_Type", ...labels]);
if (perfect.status !== "ok" || perfect.score !== 1) fail("evaluator", `a perfect predictions.csv scored ${perfect.score} (${perfect.details})`);
const constant = await score(["Cover_Type", ...labels.map(() => "2")]);
if (constant.status !== "ok" || !(constant.score !== null && constant.score > 0 && constant.score < 0.9))
  fail("evaluator", `an all-2 predictions.csv scored ${constant.score}`);
const broken = await score(["Cover_Type", "1"]);
if (broken.status !== "error") fail("evaluator", "a predictions.csv with the wrong number of rows was not refused");
report("evaluator", `perfect file 1, all-2 file ${constant.score}, wrong-length file refused`);

// ---- 5. the keeper --------------------------------------------------------
// the dummy lives next to the labels and is hidden into runs/: this is the real test that the labels can be moved there (the keeper renames; device numbers lie on overlay file systems)
const keeperRoot = mkdtempSync(join(runs, ".preflight-"));
const dummy = join(labelsDir, ".preflight-dummy.txt");
writeFileSync(dummy, "dummy");
const keeper = new HiddenKeeper({ dir: join(keeperRoot, "keeper") });
keeper.hide([dummy]);
if (existsSync(dummy)) fail("keeper", "the dummy file is still in its place after hide");
const restored = keeper.restore();
if (!existsSync(dummy) || restored.conflicts.length > 0 || restored.missing.length > 0)
  fail("keeper", `restore did not put the dummy file back: ${JSON.stringify(restored)}`);
const open = HiddenKeeper.recover(join(keeperRoot, "keeper"));
if (open.restored.length > 0 || open.conflicts.length > 0) fail("keeper", `recover found something open: ${JSON.stringify(open)}`);
rmSync(dummy, { force: true });
rmSync(keeperRoot, { recursive: true, force: true });
report("keeper", "hid a dummy file from the labels directory into runs/ and restored it; recover finds nothing open");

// ---- 6. the review guard, offline ----------------------------------------
{
  const work = mkdtempSync(join(tmpdir(), "infinity-guard-"));
  writeFileSync(join(work, "a.txt"), "x");
  const handlers: Record<string, (...input: never[]) => unknown> = {};
  reviewGuard({ workDir: work, maxTurns: 3 }).setup({
    on: (hook: string, handler: never) => {
      handlers[hook] = handler;
    },
    registerTool: () => {},
    emit: () => {},
  } as never);
  const ask = async (name: string, callArgs: unknown) =>
    (
      (await (handlers["tool.before"] as (...input: unknown[]) => Promise<{ kind: string }>)({ id: "1", name, args: callArgs }, { env: { cwd: work } })) as {
        kind: string;
      }
    ).kind;
  const verdicts = [
    await ask("read", { path: "a.txt" }),
    await ask("write", { path: "a.txt" }),
    await ask("edit", { path: "a.txt" }),
    await ask("bash", { command: "ls" }),
    await ask("submit", { command: "x" }),
    await ask("read", { path: "/etc/hosts" }),
  ];
  rmSync(work, { recursive: true, force: true });
  if (verdicts.join(",") !== "allow,deny,deny,deny,deny,deny") fail("review guard", `read/write/edit/bash/submit/read-outside gave ${verdicts.join(",")}`);
  report("review guard", "read of an own file allowed; write, edit, bash, submit and a read outside refused");
}

// ---- 7. the model ---------------------------------------------------------
if (offline) {
  console.log("--   skipped (offline): the model request and the cache probe");
} else {
  const key = process.env.OPENCODE_API_KEY;
  if (!key) fail("model key", "OPENCODE_API_KEY is not set");
  report("model key", "set");
  const model = opencodeModel(key);
  const client = createChatClient(model);
  let answer = "";
  let tokens = 0;
  // TCP connect time to the provider, and the first event of a real streaming request, under the same 5 s connect attempt timeout that runTask sets.
  // With Node's default of 250 ms a connect slower than that failed with "fetch failed" (docs/decisions.md 64).
  allowSlowConnects();
  const connectMs = await new Promise<number>((resolveConnect) => {
    const began = Date.now();
    const socket = connect({ host: new URL(model.baseUrl).hostname, port: 443, timeout: 10_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(Date.now() - began);
    });
    socket.once("error", () => resolveConnect(-1));
    socket.once("timeout", () => {
      socket.destroy();
      resolveConnect(-1);
    });
  });
  if (connectMs < 0) fail("provider connect", "a TCP connection to the provider could not be made within 10 s");
  report("provider connect", `TCP connect ${connectMs} ms (Node's default attempt timeout is 250 ms; runTask sets ${CONNECT_ATTEMPT_TIMEOUT_MS} ms)`);
  const requestBegan = Date.now();
  let firstEventMs = -1;
  try {
    for await (const event of client.stream(
      { system: "Answer with one word.", messages: [{ role: "user", ts: Date.now(), content: [{ type: "text", text: "Say OK." }] }], tools: [], maxTokens: 20 },
      AbortSignal.timeout(60_000),
    )) {
      if (firstEventMs < 0) firstEventMs = Date.now() - requestBegan;
      if (event.type === "text_delta") answer += event.delta;
      if (event.type === "usage") tokens = event.usage.input + event.usage.output;
    }
  } catch (error) {
    fail("model request", `${error instanceof Error ? error.message.slice(0, 200) : "failed"}`);
  }
  report(
    "model request",
    `a one-word request worked (${answer.trim() === "" ? "the model spent its tokens on reasoning" : "answered"}), ${tokens} tokens, first event after ${firstEventMs} ms`,
  );

  // a short real session, forked, and a reviewer with the guard: the first reviewer request must come mostly from the provider's cache (S0: 96 %)
  const probe = mkdtempSync(join(tmpdir(), "infinity-probe-"));
  const work = join(probe, "work");
  mkdirSync(work);
  const seen: Array<{ label: string; goalCheck: boolean; usage?: { input: number; cacheRead: number } }> = [];
  let label = "main";
  const recording: LlmClient = {
    model: client.model,
    async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
      const lastText = JSON.stringify(request.messages.at(-1)?.content ?? "");
      const entry: (typeof seen)[number] = { label, goalCheck: lastText.includes("You are about to stop. Check your work against the goal") };
      seen.push(entry);
      for await (const event of client.stream(request, signal)) {
        if (event.type === "usage") entry.usage = event.usage;
        yield event;
      }
    },
  };
  // one function builds the agent and its reviewer, as in the worker, so that nothing but the guard differs
  const build = (name: string, extra: Plugin[]) =>
    createAgent({
      model: recording,
      cwd: work,
      confine: true,
      tools: ["read", "write"],
      plugins: [...corePlugins(), ...extra],
      rules: ["Make exactly one tool call per reply, never several at once."],
      sessionFile: join(probe, `${name}.jsonl`),
      goal: { objective: "Keep producing correct files until told to stop.", verify: "test -f ../finished" },
    });
  const main = await build("main", []);
  let turns = 0;
  const run = main.run("For n = 1 to 40: write squares/<n>.txt containing n*n, then read it back with the read tool.");
  const timer = setInterval(() => turns >= 10 && main.cancel(), 200);
  for await (const event of run.events as AsyncIterable<Event>) if (event.type === "turn_end") turns += 1;
  clearInterval(timer);
  await run.result;
  const forkPath = join(probe, "fork.jsonl");
  await main.fork(forkPath);
  const evidence = readReviewEvidence(forkPath);
  const guard = reviewGuard({ workDir: work, maxTurns: 3 });
  const reviewer = await build("fork", [guard]);
  guard.bind(reviewer);
  label = "review";
  const first = seen.length;
  const result = await reviewer.run(reviewQuestion({}, evidence)).result;
  const response = guard.text().trim();
  const firstReview = seen[first]?.usage;
  await Promise.all([main.close(), reviewer.close()]);
  rmSync(probe, { recursive: true, force: true });
  const reviewRequests = seen.filter((entry) => entry.label === "review");
  if (reviewRequests.some((entry) => entry.goalCheck)) fail("cache probe", "the goal check ran in the reviewer: the stop at its first final text did not work");
  if (!firstReview) fail("cache probe", `the reviewer made no counted request (ended ${result.reason})`);
  try {
    parseReviewSnapshot(response, {}, evidence, { observedAt: Date.now(), observedTurn: turns });
  } catch {
    fail("cache probe", "the reviewer did not return a valid snapshot");
  }
  const share = firstReview.cacheRead / (firstReview.input + firstReview.cacheRead);
  if (share < cacheFloor)
    fail(
      "cache probe",
      `${(100 * share).toFixed(0)} % of the reviewer's first request came from the cache; the floor is ${(100 * cacheFloor).toFixed(0)} % (--cache-floor). Prefix of the fork differs, or the provider does not cache.`,
    );
  report(
    "cache probe",
    `${turns} turns, fork, reviewer's first request ${(100 * share).toFixed(0)} % from the cache (floor ${(100 * cacheFloor).toFixed(0)} %), run ended '${result.reason}' after ${reviewRequests.length} requests, none of them a goal check`,
  );
}

// ---- 8. a dry run with a scripted model -----------------------------------
const dryRoot = mkdtempSync(join(runs, ".preflight-dry-"));
const model = createScriptedCodeModel({ hints: ["a", "b"], value: (_hint, cycle) => cycle, latencyMs: 20 });
const dry = defineTask({
  name: "preflight dry run",
  mode: "code",
  prompt: "Raise the number in pred.txt.",
  evaluate: async ({ workDir }) => ({ status: "ok", score: Number(readFileSync(join(workDir, "pred.txt"), "utf8")) / 100, metrics: {}, details: "" }),
  metric: { name: "score", direction: "max" },
  review: false,
  branchReview: { everyMinutes: 0.01, maxTurns: 3, maxConcurrent: 1 },
  agents: 2,
  model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
  stop: "until-stopped",
  runsDir: dryRoot,
});
const stop = new AbortController();
setTimeout(() => stop.abort(), drySeconds * 1000);
const outcome = await runTask(dry, { createClient: () => model, signal: stop.signal, checkEveryMs: 1000 });
const reportFile = join(outcome.runDir, "report", "report.html");
if (outcome.reason !== "stopped" || !existsSync(reportFile))
  fail("dry run", `ended with '${outcome.reason}', report ${existsSync(reportFile) ? "written" : "missing"}`);
rmSync(dryRoot, { recursive: true, force: true });
report("dry run", `2 scripted agents for ${drySeconds} s ended in order and wrote the report`);
console.log("preflight passed");
