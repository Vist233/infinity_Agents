import { type LlmClient, type LlmEvent, type LlmRequest, ProviderError } from "sakura-agent";

export interface ScriptedModelOptions {
  /** What the planner answers. */
  hints: string[];
  /** Whether the agent with this hint writes a proof the fake verifier accepts, at its n-th attempt (1 based). */
  isGood: (hint: string, attempt: number) => boolean;
  latencyMs?: number;
  /** Requests running at once above this are answered with a rate-limit error, like a provider that throttles. */
  maxConcurrent?: number;
  retryAfterMs?: number;
  /** Fail every request with this error (quota tests). */
  failWith?: ProviderError;
  /** An agent request for which this returns true never gets an answer (until it is cancelled): a stuck agent. (hint, n-th request of that hint, 1 based) */
  hangs?: (hint: string, request: number) => boolean;
  /** Every agent request fails with this error (not the planner). */
  failAgentsWith?: ProviderError;
  /** The file an agent writes when its proof should be accepted (default: a file the fake verifier accepts). */
  goodProof?: string;
  /** After this many requests every request fails with a quota error (the money ran out). */
  quotaAfter?: number;
  /** Write the same file again and again instead of a new one each time, so that a commit finds nothing to do (light on Git in big tests). */
  constantContent?: boolean;
  /** Tokens reported per reply. */
  tokens?: { input: number; output: number };
}

export interface ScriptedModel extends LlmClient {
  requestCount: number;
  peakConcurrent: number;
  throttled: number;
}

type ToolCallPart = { type: "tool_call"; name: string };

const hintOf = (system: string): string => /Your strategy hint: (.*?) It is a suggestion/.exec(system)?.[1] ?? "";

/**
 * A model that plays the agents of a math run without thinking: write a proof file, submit it, repeat; stop when a submit is accepted.
 * Also answers the planner and the goal check. What the file contains depends on the strategy hint, so a test chooses who succeeds.
 */
export function createScriptedModel(options: ScriptedModelOptions): ScriptedModel {
  let active = 0;
  const seen = new Map<string, number>();
  const model: ScriptedModel = {
    model: { id: "scripted", contextWindow: 100_000, supportsImages: false },
    requestCount: 0,
    peakConcurrent: 0,
    throttled: 0,
    async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
      model.requestCount += 1;
      if (options.failWith) throw options.failWith;
      if (options.quotaAfter !== undefined && model.requestCount > options.quotaAfter) throw new ProviderError("quota", "insufficient balance", 402);
      const isAgent = request.tools.length > 0;
      if (isAgent && options.failAgentsWith) throw options.failAgentsWith;
      if (isAgent && options.hangs) {
        const hint = hintOf(request.system);
        seen.set(hint, (seen.get(hint) ?? 0) + 1);
        if (options.hangs(hint, seen.get(hint) ?? 0)) await sleep(2 ** 31 - 1, signal);
      }
      if (options.maxConcurrent !== undefined && active >= options.maxConcurrent) {
        model.throttled += 1;
        throw new ProviderError("rate_limit", "too many requests", 429, options.retryAfterMs ?? 20);
      }
      active += 1;
      model.peakConcurrent = Math.max(model.peakConcurrent, active);
      try {
        await sleep(options.latencyMs ?? 2, signal);
        yield* reply(request, options);
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

function* reply(request: LlmRequest, options: ScriptedModelOptions): Generator<LlmEvent> {
  if (request.system.startsWith("You plan a team")) return yield { type: "text_delta", delta: JSON.stringify(options.hints) };
  const lastUserText =
    request.messages
      .at(-1)
      ?.content.map((part) => (part.type === "text" ? part.text : ""))
      .join("") ?? "";
  // the goal check is an ordinary-looking request (the tools are declared) whose last message asks for the checklist
  if (lastUserText.startsWith("You are about to stop. Check your work against the goal"))
    return yield { type: "text_delta", delta: "- [done] a proof was accepted :: the marker exists" };

  const calls = request.messages.flatMap((message) =>
    message.role === "assistant" ? message.content.filter((part): part is ToolCallPart & { id: string; args: unknown } => part.type === "tool_call") : [],
  );
  const writes = calls.filter((call) => call.name === "write").length;
  const submits = calls.filter((call) => call.name === "lean").length;
  const lastMessage = request.messages.at(-1);
  const lastText = lastMessage?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
  if (lastMessage?.role === "tool" && lastText.startsWith("proved")) return yield { type: "text_delta", delta: "Done: the proof is accepted." };

  const hint = hintOf(request.system);
  const id = `call_${writes}_${submits}`;
  if (writes === submits) {
    const content = options.isGood(hint, writes + 1)
      ? (options.goodProof ?? "import Statement\n-- GOOD\n")
      : `import Statement\n-- BAD ${options.constantContent ? 0 : writes}\n`;
    return yield { type: "tool_call", call: { id, name: "write", args: { path: "Proof.lean", content } } };
  }
  return yield { type: "tool_call", call: { id, name: "lean", args: { action: "submit" } } };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
