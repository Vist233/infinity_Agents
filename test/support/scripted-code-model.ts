import { type LlmClient, type LlmEvent, type LlmRequest, ProviderError } from "sakura-agent";

export interface ScriptedCodeModelOptions {
  hints: string[];
  /** The value an agent with this hint writes at its n-th cycle (1 based). The fake evaluator turns it into a score. */
  value: (hint: string, cycle: number) => number;
  latencyMs?: number;
  /** Requests running at once above this are answered with a rate-limit error. */
  maxConcurrent?: number;
  retryAfterMs?: number;
  quotaAfter?: number;
  tokens?: { input: number; output: number };
  /** Called with every agent request (not the planner): lets a test look at what the agent was sent. */
  onRequest?: (request: LlmRequest) => void;
  /** Extra tool call an agent makes in each cycle before it submits (for example a bash command). */
  /** Numbers sent as `claim` in each submit (for a task without a scorer). */
  claim?: (cycle: number) => Record<string, number>;
  /** Extra tool calls an agent makes in each cycle before it submits (for example bash commands). */
  extraCalls?: (cycle: number) => Array<{ name: string; args: unknown }>;
  /** What the safety reviewer answers for an action (its text); default allow. Counted in `reviews`. */
  /** What a branch reviewer does at its n-th reply (1 based). Default: a valid unknown snapshot. */
  reviewer?: (step: number) => { call: { name: string; args: unknown } } | { text: string } | { fail: string } | { hang: true };
  reviewVerdict?: (action: string) => "allow" | "deny";
}

export interface ScriptedCodeModel extends LlmClient {
  requestCount: number;
  peakConcurrent: number;
  throttled: number;
  /** The actions the reviewer was asked about. */
  reviews: string[];
  /** Requests of branch reviewers (the conversation ends with, or contains, the review question). */
  branchRequests: LlmRequest[];
  /** Requests of agents that are not reviewers, in order. */
  agentRequests: LlmRequest[];
  /** Tool results the branch reviewers saw, in order. */
  branchToolResults: string[];
  goalChecks: number;
}

type CallPart = { type: "tool_call"; id: string; name: string; args: unknown };
const hintOf = (system: string): string => /Your strategy hint: (.*?) It is a suggestion/.exec(system)?.[1] ?? "";
const textOf = (parts: Array<{ type: string; text?: string }> | undefined): string =>
  (parts ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

export function scriptedReview(steer: string | null = null, details: Record<string, unknown> = {}): string {
  const observed = steer !== null || Object.keys(details).length > 0;
  return JSON.stringify({
    status: observed ? "working" : "unknown",
    assessment: observed ? "on_track" : "unknown",
    priority: observed ? 1 : null,
    summary: observed ? "The agent has a tool result." : "No assessment yet.",
    reason: observed ? "A tool result is available." : "The evidence is insufficient.",
    evidenceRefs: observed ? ["E1"] : [],
    steer,
    details,
  });
}

/**
 * A model that plays the agents of a code run without thinking. Each cycle: write pred.txt, [an extra call], submit it, read the score, again.
 * It never stops by itself (the run ends by a target, a budget, a quota or the user).
 */
export function createScriptedCodeModel(options: ScriptedCodeModelOptions): ScriptedCodeModel {
  let active = 0;
  const model: ScriptedCodeModel = {
    model: { id: "scripted-code", contextWindow: 100_000, supportsImages: false },
    requestCount: 0,
    peakConcurrent: 0,
    throttled: 0,
    reviews: [],
    branchRequests: [],
    agentRequests: [],
    branchToolResults: [],
    goalChecks: 0,
    async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
      model.requestCount += 1;
      if (options.quotaAfter !== undefined && model.requestCount > options.quotaAfter) throw new ProviderError("quota", "insufficient balance", 402);
      if (options.maxConcurrent !== undefined && active >= options.maxConcurrent) {
        model.throttled += 1;
        throw new ProviderError("rate_limit", "too many requests", 429, options.retryAfterMs ?? 20);
      }
      active += 1;
      model.peakConcurrent = Math.max(model.peakConcurrent, active);
      try {
        await sleep(options.latencyMs ?? 2, signal);
        const step = branchStep(request);
        if (step !== undefined) {
          const action = options.reviewer?.(step);
          if (action && "hang" in action) await sleep(2 ** 31 - 1, signal);
        }
        if (request.tools.length > 0 && !request.system.startsWith("You plan a team")) options.onRequest?.(request);
        yield* reply(request, options, model);
        const tokens = options.tokens ?? { input: 100, output: 20 };
        yield { type: "usage", usage: { input: tokens.input, output: tokens.output, cacheRead: 0, cacheWrite: 0 } };
        yield { type: "done", stop: "stop" };
      } finally {
        active -= 1;
      }
    },
  };
  return model;
}

/** The reply number of a branch reviewer's conversation (1 based), or undefined when the request is not from one. */
function branchStep(request: LlmRequest): number | undefined {
  const questionAt = request.messages.findIndex(
    (message) => message.role === "user" && textOf(message.content as never).startsWith("This is a review by an outside reviewer"),
  );
  if (questionAt < 0) return undefined;
  const last = request.messages.at(-1);
  if (textOf(last?.content as never).startsWith("You are about to stop. Check your work against the goal")) return undefined;
  return request.messages.slice(questionAt).filter((message) => message.role === "assistant").length + 1;
}

function* reply(request: LlmRequest, options: ScriptedCodeModelOptions, model: ScriptedCodeModel): Generator<LlmEvent> {
  if (request.system.startsWith("You plan a team")) return yield { type: "text_delta", delta: JSON.stringify(options.hints) };
  if (request.system.startsWith("You are a safety reviewer")) {
    const action = textOf(request.messages.at(-1)?.content as never);
    model.reviews.push(action);
    const outcome = options.reviewVerdict?.(action) ?? "allow";
    return yield {
      type: "text_delta",
      delta: JSON.stringify({ risk_level: outcome === "allow" ? "low" : "critical", user_authorization: "high", outcome, rationale: "scripted" }),
    };
  }
  const last = request.messages.at(-1);
  const step = branchStep(request);
  const goalCheck = textOf(last?.content as never).startsWith("You are about to stop. Check your work against the goal");
  if (goalCheck) model.goalChecks += 1;
  if (step !== undefined) {
    model.branchRequests.push(request);
    if (last?.role === "tool") model.branchToolResults.push(textOf(last.content as never));
    const action = options.reviewer?.(step) ?? { text: scriptedReview() };
    if ("fail" in action) throw new Error(action.fail);
    if ("text" in action) return yield { type: "text_delta", delta: action.text };
    if ("hang" in action) return;
    return yield { type: "tool_call", call: { id: `review_${step}`, name: action.call.name, args: action.call.args } };
  }
  model.agentRequests.push(request);
  if (goalCheck) return yield { type: "text_delta", delta: "- [todo] keep improving the score :: the run has not ended" };

  const calls = request.messages.flatMap((message) =>
    message.role === "assistant" ? (message.content.filter((part) => part.type === "tool_call") as CallPart[]) : [],
  );
  const count = (name: string) => calls.filter((call) => call.name === name).length;
  const submits = count("submit");
  const writes = count("write");
  const extras = calls.filter((call) => call.name !== "write" && call.name !== "submit").length;
  const cycle = submits + 1;
  const id = `call_${calls.length}`;
  const planned = Array.from({ length: cycle }, (_, index) => options.extraCalls?.(index + 1) ?? []);
  const wanted = planned.flat();
  const extra = wanted[extras];
  if (writes === submits) {
    const value = options.value(hintOf(request.system), cycle);
    return yield { type: "tool_call", call: { id, name: "write", args: { path: "pred.txt", content: String(value) } } };
  }
  if (extra && extras < planned.flat().length) return yield { type: "tool_call", call: { id, name: extra.name, args: extra.args } };
  return yield {
    type: "tool_call",
    call: { id, name: "submit", args: { command: `echo ${cycle}`, files: ["pred.txt"], ...(options.claim ? { claim: options.claim(cycle) } : {}) } },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) return abort();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        abort();
      },
      { once: true },
    );
  });
}
