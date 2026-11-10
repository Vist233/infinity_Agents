/** A fake chat provider as a `fetch`: answers like a Chat Completions server, and throttles above a chosen concurrency. */
export interface FakeProviderOptions {
  /** Requests running at the same moment above this get a 429. Default: unlimited. */
  maxConcurrent?: number;
  retryAfterMs?: number;
  /** How long a reply takes, in real milliseconds. */
  latencyMs?: number;
  /** Answer with this HTTP status and body instead of a reply (for quota tests). */
  failWith?: { status: number; body: string };
  /** Tokens reported for each reply. */
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface FakeProvider {
  fetch: typeof fetch;
  /** Every request that reached the server: when it arrived and whether it was throttled. */
  hits: Array<{ at: number; throttled: boolean }>;
  readonly peakConcurrent: number;
}

const encoder = new TextEncoder();

function sse(payloads: unknown[]): string {
  return `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`;
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const usage = options.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
  let active = 0;
  let peak = 0;
  const hits: FakeProvider["hits"] = [];

  const reply = async (): Promise<Response> => {
    await new Promise((resolve) => setTimeout(resolve, options.latencyMs ?? 5));
    const body = sse([{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }]);
    return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const fakeFetch = async (): Promise<Response> => {
    if (options.failWith) {
      hits.push({ at: Date.now(), throttled: false });
      return new Response(options.failWith.body, { status: options.failWith.status });
    }
    if (options.maxConcurrent !== undefined && active >= options.maxConcurrent) {
      hits.push({ at: Date.now(), throttled: true });
      return new Response("rate limited", { status: 429, headers: { "retry-after-ms": String(options.retryAfterMs ?? 30) } });
    }
    hits.push({ at: Date.now(), throttled: false });
    active += 1;
    peak = Math.max(peak, active);
    try {
      return await reply();
    } finally {
      active -= 1;
    }
  };

  return {
    fetch: fakeFetch as typeof fetch,
    hits,
    get peakConcurrent() {
      return peak;
    },
  };
}
