import { type LlmClient, ProviderError, type Usage, createChatClient } from "sakura-agent";
import { describe, expect, it } from "vitest";
import { realClock } from "../src/clock.ts";
import { Gate, type GateEvent, type GateOptions } from "../src/gate.ts";
import { type FakeProviderOptions, createFakeProvider } from "./support/fake-provider.ts";

const request = { system: "s", messages: [], tools: [] };

function setup(provider: FakeProviderOptions, gateOptions: Partial<GateOptions> = {}) {
  const fake = createFakeProvider(provider);
  const events: GateEvent[] = [];
  const gate = new Gate({
    now: realClock.now,
    sleep: realClock.sleep,
    defaultPauseMs: 40,
    onEvent: (event) => events.push(event),
    ...gateOptions,
  });
  const client = createChatClient({
    baseUrl: "http://fake",
    apiKey: "k",
    model: "m",
    contextWindow: 1000,
    fetch: fake.fetch,
    retry: { ...gate.retry, baseDelayMs: 1, maxRetries: 8 },
  });
  return { fake, gate, events, gated: gate.wrap(client) };
}

async function drain(client: LlmClient, signal = new AbortController().signal): Promise<Usage | undefined> {
  let usage: Usage | undefined;
  for await (const event of client.stream(request, signal)) if (event.type === "usage") usage = event.usage;
  return usage;
}

describe("Gate", () => {
  it("passes the reply through and reports the usage of every request", async () => {
    const { gated, events } = setup({});
    await drain(gated);
    await drain(gated);
    const usages = events.filter((event) => event.type === "usage");
    expect(usages).toHaveLength(2);
    expect(usages.every((event) => event.type === "usage" && event.latencyMs >= 0)).toBe(true);
  });

  it("says when it is paused", async () => {
    const { gate } = setup({});
    expect(gate.paused).toBe(false);
    gate.retry.onRetry({ delayMs: 1000, error: new ProviderError("rate_limit", "slow down") });
    expect(gate.paused).toBe(true);
  });

  it("counts requests in flight and returns to zero, also after an error", async () => {
    const { gated, gate } = setup({ latencyMs: 30 });
    const running = drain(gated);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gate.inflight).toBe(1);
    await running;
    expect(gate.inflight).toBe(0);

    const failing = setup({ failWith: { status: 401, body: "bad key" } });
    await expect(drain(failing.gated)).rejects.toThrow();
    expect(failing.gate.inflight).toBe(0);
  });

  it("pauses every agent after one throttling answer: nothing reaches the provider during the pause", async () => {
    const { gated, fake, events } = setup({ maxConcurrent: 1, retryAfterMs: 80, latencyMs: 40 });
    const first = drain(gated);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = drain(gated); // is throttled (the first still runs) and sets the pause
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = drain(gated); // arrives during the pause and must wait for it
    await Promise.all([first, second, third]);

    const throttledAt = fake.hits.find((hit) => hit.throttled)?.at ?? Number.POSITIVE_INFINITY;
    const duringPause = fake.hits.filter((hit) => !hit.throttled && hit.at > throttledAt && hit.at < throttledAt + 75);
    expect(duringPause).toEqual([]);
    expect(events.some((event) => event.type === "throttle")).toBe(true);
  });

  it("lets eight agents through a provider that throttles above three: all finish", async () => {
    const { gated, fake, events } = setup({ maxConcurrent: 3, retryAfterMs: 20, latencyMs: 15 });
    await Promise.all(Array.from({ length: 8 }, () => drain(gated)));
    expect(fake.peakConcurrent).toBeLessThanOrEqual(3);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(8);
  });

  it("stops everything on a quota error, and later requests never reach the provider", async () => {
    const { gated, gate, fake, events } = setup({ failWith: { status: 402, body: "insufficient balance" } });
    await expect(drain(gated)).rejects.toMatchObject({ kind: "quota" });
    expect(gate.stopped).toContain("insufficient");
    const hitsBefore = fake.hits.length;
    await expect(drain(gated)).rejects.toMatchObject({ kind: "quota" });
    expect(fake.hits.length).toBe(hitsBefore);
    expect(events.filter((event) => event.type === "quota")).toHaveLength(1);
  });

  it("refuses a new request when the refusal hook says so, without calling the provider", async () => {
    const { gated, fake, events } = setup({}, { refusal: () => "budget reached" });
    await expect(drain(gated)).rejects.toBeInstanceOf(ProviderError);
    expect(fake.hits).toHaveLength(0);
    expect(events).toContainEqual({ type: "refused", reason: "budget reached" });
  });

  it("stops waiting for a pause when the agent is cancelled", async () => {
    const { gated, gate, fake } = setup({});
    gate.retry.onRetry({ delayMs: 5000, error: new ProviderError("rate_limit", "slow down") });
    const controller = new AbortController();
    const waiting = drain(gated, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gate.inflight).toBe(0);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(fake.hits).toHaveLength(0);
  });

  it("can be stopped silently: the same refusals, no announcement", async () => {
    const { gated, gate, events } = setup({});
    gate.stop("the budget ended", { silent: true });
    await expect(drain(gated)).rejects.toMatchObject({ kind: "quota" });
    expect(events.filter((event) => event.type === "quota")).toEqual([]);
  });

  it("stops by request of the orchestrator", async () => {
    const { gated, gate } = setup({});
    gate.stop("stopped by the user");
    await expect(drain(gated)).rejects.toMatchObject({ kind: "quota", message: "stopped by the user" });
  });
});
