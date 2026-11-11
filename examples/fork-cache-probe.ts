/**
 * Experiment S0 of docs/10: does a forked session hit the provider's prompt cache, and does the goal check run in the fork?
 *
 *   node examples/fork-cache-probe.ts
 *
 * Real model through OpenCode Go; the key is read from OPENCODE_API_KEY and is never printed. Everything is written under runs/fork-probe-<time>/.
 * It prints one JSON line per model request (label, number of messages, usage) and a summary. No product code is used.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Agent,
  type Event,
  type LlmClient,
  type LlmEvent,
  type LlmRequest,
  type Plugin,
  compatPresets,
  corePlugins,
  createAgent,
  createChatClient,
} from "sakura-agent";

const apiKey = process.env.OPENCODE_API_KEY;
if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");

const root = join("runs", `fork-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const workDir = join(root, "work");
mkdirSync(workDir, { recursive: true });
const sessionFile = join(root, "main.jsonl");

const modelConfig = {
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKey,
  model: "deepseek-v4.1-flash",
  contextWindow: 128_000,
  compat: compatPresets.deepseek,
  headers: { "x-opencode-session": randomUUID() },
};

// ----- a recording client: every request and its usage, with a label that says who asked -----
interface Seen {
  label: string;
  request: LlmRequest;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
const seen: Seen[] = [];
let label = "main";
const real = createChatClient(modelConfig);
const recording: LlmClient = {
  model: real.model,
  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
    const entry: Seen = { label, request };
    seen.push(entry);
    try {
      for await (const event of real.stream(request, signal)) {
        if (event.type === "usage") entry.usage = event.usage;
        yield event;
      }
    } finally {
      printRequests(seen.indexOf(entry), seen.indexOf(entry) + 1);
    }
  },
};

const RULES = ["Work only with the read and write tools. Make exactly one tool call per reply, never several at once."];
const GOAL = { objective: "Keep producing correct files for the task until you are told to stop.", verify: "test -f ../finished" };
const TASK =
  "For n = 1 to 40 do this, in order: write the file squares/<n>.txt containing the number n*n (only the number), then read it back with the read tool. " +
  "After n = 40 write squares/summary.txt listing the 40 results, then say 'done'.";

function build(sessionPath: string, extra: Plugin[]): Promise<Agent> {
  return createAgent({
    model: recording,
    cwd: workDir,
    confine: true,
    tools: ["read", "write"],
    plugins: [...corePlugins(), ...extra],
    rules: RULES,
    sessionFile: sessionPath,
    goal: GOAL,
  });
}

const REVIEW_QUESTION =
  "This is a review by an outside reviewer, not a task. Stop working as the agent. Look at the last stretch of the conversation and at the files (you may read them). " +
  "Is the agent on a promising path toward the goal? If yes, answer exactly `OK`. If not, say in at most five sentences what is wrong and what to do instead. " +
  "Do not praise. Do not repeat what the agent already knows.";

/** Allows `read` only. Optionally stops the run when the reviewer's reply has no tool call (before the goal check can run). */
function reviewerGuard(stopAtFinalText: boolean, state: { text: string; denied: string[]; agent?: Agent }): Plugin {
  return {
    name: "review-guard",
    setup(api) {
      api.on("tool.before", (call) => {
        if (call.name === "read") return { kind: "allow" };
        state.denied.push(call.name);
        return { kind: "deny", reason: "only read is available during a review" };
      });
      api.on("event", (event: Event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        const calls = event.message.content.some((part) => part.type === "tool_call");
        const text = event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
        if (!calls) {
          state.text = text;
          if (stopAtFinalText) state.agent?.cancel();
        }
      });
    },
  };
}

function printRequests(from: number, to = seen.length): void {
  for (const entry of seen.slice(from, to)) {
    const last = entry.request.messages.at(-1);
    const lastText = last?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";
    console.log(
      JSON.stringify({
        label: entry.label,
        messages: entry.request.messages.length,
        tools: entry.request.tools?.length ?? 0,
        lastRole: last?.role,
        goalCheck: lastText.startsWith("You are about to stop"),
        usage: entry.usage,
      }),
    );
  }
}

function commonPrefix(a: LlmRequest, b: LlmRequest): number {
  let n = 0;
  while (n < a.messages.length && n < b.messages.length && JSON.stringify(a.messages[n]) === JSON.stringify(b.messages[n])) n++;
  return n;
}

async function review(name: string, stopAtFinalText: boolean): Promise<void> {
  const forkPath = join(root, `fork-${name}.jsonl`);
  await main.fork(forkPath);
  const state: { text: string; denied: string[]; agent?: Agent } = { text: "", denied: [] };
  const reviewer = await build(forkPath, [reviewerGuard(stopAtFinalText, state)]);
  state.agent = reviewer;
  label = `review-${name}`;
  const before = seen.length;
  const run = reviewer.run(REVIEW_QUESTION);
  const result = await run.result;
  console.log(JSON.stringify({ reviewer: name, ended: result.reason, denied: state.denied, text: state.text.slice(0, 300) }));
  const first = seen[before];
  const lastMain = [...seen].reverse().find((entry) => entry.label === "main");
  if (first && lastMain) {
    const shared = commonPrefix(first.request, lastMain.request);
    console.log(
      JSON.stringify({
        reviewer: name,
        sameSystem: first.request.system === lastMain.request.system,
        sameTools: JSON.stringify(first.request.tools) === JSON.stringify(lastMain.request.tools),
        mainLastMessages: lastMain.request.messages.length,
        sharedPrefixMessages: shared,
        firstRequestMessages: first.request.messages.length,
      }),
    );
  }
  await reviewer.close();
}

// ----- phase A: a main agent works for 30+ turns, then is forked while it runs -----
let turns = 0;
const counter: Plugin = {
  name: "turn-counter",
  setup(api) {
    api.on("event", (event: Event) => {
      if (event.type === "turn_end") turns++;
    });
  },
};
const main = await build(sessionFile, [counter]);
const mainRun = main.run(TASK);
const stopper = setInterval(() => {
  if (turns >= 32) main.cancel();
}, 200);
const mainResult = await mainRun.result;
clearInterval(stopper);
console.log(JSON.stringify({ phase: "main", ended: mainResult.reason, turns, requests: seen.length, files: existsSync(join(workDir, "squares/40.txt")) }));

// ----- phase B: two reviewers from the same snapshot -----
// the variant without the stop ("plain") was run once by hand: the goal check ran after the first final text and then looped (docs/test-report.md)
await review("cancel-at-final-text", true); // the run is cancelled at the reviewer's first final text
await main.close();
writeFileSync(
  join(root, "requests.json"),
  JSON.stringify(
    seen.map((entry) => ({ label: entry.label, messages: entry.request.messages.length, usage: entry.usage })),
    null,
    1,
  ),
);
console.log(`done: ${root}`);
