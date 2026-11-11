import { realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Agent, Event, LlmClient, Plugin } from "sakura-agent";
import { adviceMessage } from "./prompts.ts";
import { type ReviewOutputSettings, type ReviewSnapshot, parseReviewSnapshot, readReviewEvidence, reviewQuestion } from "./review-snapshot.ts";

/** What the worker offers: the agent's conversation can be forked, a reviewer opened on the fork, and advice steered in. */
export interface ReviewTarget {
  /** Replies the agent has made so far. */
  replies(): number;
  fork(path: string): Promise<void>;
  /** Opens an agent on the forked file with the main agent's configuration (plus `guard`, minus the commit plugin) and its client passed through `wrapClient`. */
  openReviewer(sessionFile: string, guard: Plugin, wrapClient: (client: LlmClient) => LlmClient): Promise<Agent>;
  /** Hands text to the agent: now if a run is active, else at the start of its next run. */
  advise(text: string): void;
}

export interface ReviewOutcome {
  outcome: "ok" | "steer" | "error";
  text?: string;
  ms: number;
  tokens: number;
  /** Of `tokens`, those the provider served from its cache. */
  cacheRead?: number;
  error?: string;
  snapshot?: ReviewSnapshot;
}

/** The deny hook, the stop at the first final text (before the goal check can run, docs/test-report S0) and the turn limit, as one plugin. */
export function reviewGuard(options: { workDir: string; maxTurns: number }): Plugin & { bind(agent: Agent): void; text(): string } {
  const workDir = realpathSync(options.workDir);
  let agent: Agent | undefined;
  let last = "";
  let turns = 0;
  return {
    name: "branch-review-guard",
    bind: (bound) => {
      agent = bound;
    },
    text: () => last,
    setup(api) {
      api.on("tool.before", async (call, context) => {
        if (call.name !== "read") return { kind: "deny", reason: "Only read is available during a review." };
        const path = (call.args as { path?: unknown } | undefined)?.path;
        if (typeof path !== "string") return { kind: "deny", reason: "Only read of a file in the agent's directory is available during a review." };
        // an absolute path stands for itself; a path that is not there yet is judged by its written form (found by the preflight: "/etc/hosts" was once let through because join() glued it to the directory)
        const target = resolve(context.env.cwd, path);
        let real = target;
        try {
          real = realpathSync(target);
        } catch {
          // not there: the tool will say "not found"; only the written form can be judged
        }
        if (real === workDir || real.startsWith(`${workDir}/`)) return { kind: "allow" };
        return { kind: "deny", reason: "During a review only files in the agent's own directory can be read." };
      });
      api.on("event", (event: Event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        turns += 1;
        const text = event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
        const calls = event.message.content.some((part) => part.type === "tool_call");
        if (!calls && event.message.stop === "stop") last = text;
        if (!calls || turns >= options.maxTurns) agent?.cancel();
      });
    },
  };
}

/** Forks, asks, collects the answer, and always deletes the fork file. Never throws: an error is an outcome. */
export async function runReview(options: {
  target: ReviewTarget;
  forkPath: string;
  workDir: string;
  maxTurns: number;
  signal: AbortSignal;
  now: () => number;
  output?: ReviewOutputSettings;
}): Promise<ReviewOutcome> {
  const started = options.now();
  const repliesAtFork = options.target.replies();
  let tokens = 0;
  let cacheRead = 0;
  let reviewer: Agent | undefined;
  try {
    if (options.signal.aborted) return { outcome: "error", ms: 0, tokens: 0, error: "the run ended before the review began" };
    await options.target.fork(options.forkPath);
    const output = options.output ?? {};
    const evidence = readReviewEvidence(options.forkPath);
    const guard = reviewGuard({ workDir: options.workDir, maxTurns: options.maxTurns });
    reviewer = await options.target.openReviewer(options.forkPath, guard, (client) => ({
      model: client.model,
      async *stream(request, signal) {
        for await (const event of client.stream(request, signal)) {
          if (event.type === "usage") {
            tokens += event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
            cacheRead += event.usage.cacheRead;
          }
          yield event;
        }
      },
    }));
    guard.bind(reviewer);
    // the cancel goes to the run itself, and is checked once more after the listener is in place, so that a stop in between cannot be missed
    const run = reviewer.run(reviewQuestion(output, evidence));
    const onAbort = () => run.cancel();
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) run.cancel();
    try {
      const result = await run.result;
      if (result.reason === "error")
        return { outcome: "error", ms: options.now() - started, tokens, cacheRead, error: result.error ?? "the reviewer's run failed" };
    } finally {
      options.signal.removeEventListener("abort", onAbort);
    }
    if (options.signal.aborted) return { outcome: "error", ms: options.now() - started, tokens, cacheRead, error: "the run ended during the review" };
    const snapshot = parseReviewSnapshot(guard.text().trim(), output, evidence, { observedAt: started, observedTurn: repliesAtFork });
    const ms = options.now() - started;
    if (snapshot.steer === null) return { outcome: "ok", ms, tokens, cacheRead, snapshot };
    const age = Math.max(0, options.target.replies() - repliesAtFork);
    options.target.advise(adviceMessage(snapshot.steer, age, ms / 1000));
    return { outcome: "steer", text: snapshot.steer, ms, tokens, cacheRead, snapshot };
  } catch (error) {
    return { outcome: "error", ms: options.now() - started, tokens, cacheRead, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await reviewer?.close().catch(() => undefined);
    for (const path of [options.forkPath, `${options.forkPath}.lock`]) rmSync(path, { force: true });
  }
}
