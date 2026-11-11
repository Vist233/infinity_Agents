import { ClusterDetector } from "./error-cluster.ts";
import { type LlmClient, type LlmEvent, type LlmRequest, ProviderError, type Usage } from "sakura-agent";

export type GateEvent =
  /** `cause` "connection": many connection errors in a short time were read as a limit of what the network or the provider can take (not an answer of the provider). */
  | { type: "throttle"; delayMs: number; pausedUntil: number; cause?: "provider" | "connection" }
  | { type: "quota"; message: string }
  | { type: "refused"; reason: string }
  | { type: "usage"; usage: Usage; latencyMs: number };

export interface GateOptions {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The pause used when a throttling answer carries no "retry after". */
  defaultPauseMs: number;
  /** Returns a reason to refuse a new request (the budget), or undefined. */
  refusal?: () => string | undefined;
  onEvent?: (event: GateEvent) => void;
  /** This many connection errors within `connectionWindowMs` count as a capacity signal: everybody pauses and the ladder drops a rung (default 5 in 10 s). */
  connectionErrors?: number;
  connectionWindowMs?: number;
}

const THROTTLE_KINDS = new Set(["rate_limit", "overloaded"]);

/**
 * One shared brake in front of every model request.
 * - Waits while a pause is active; a throttling answer pauses everybody.
 * - A quota error stops everything for good: later requests fail at once with the same error kind.
 * - Reports the usage of every request that passes (also compaction and goal checks).
 * It throws ProviderError("quota") to refuse; the framework turns that into a paused run, and the session stays resumable.
 */
export class Gate {
  private pausedUntil = 0;
  private stopMessage: string | undefined;
  private inflightCount = 0;
  private readonly connectionCluster: ClusterDetector;

  private readonly options: GateOptions;

  constructor(options: GateOptions) {
    this.options = options;
    this.connectionCluster = new ClusterDetector(options.connectionErrors ?? 5, options.connectionWindowMs ?? 10_000);
  }

  get inflight(): number {
    return this.inflightCount;
  }

  /** True while a throttling answer has everybody waiting. */
  get paused(): boolean {
    return this.pausedUntil > this.options.now();
  }

  get stopped(): string | undefined {
    return this.stopMessage;
  }

  /** Pass this to the chat client's `retry` option so the Gate hears about every throttling answer. */
  readonly retry = {
    onRetry: (info: { delayMs: number; error: ProviderError }) => {
      if (THROTTLE_KINDS.has(info.error.kind)) this.pause(info.delayMs);
    },
  };

  /**
   * Stops everything for good: requests in flight finish, every later request fails at once. Announces it as a "quota" event
   * unless `silent` (the orchestrator, which already knows why, stops the gate that way).
   */
  stop(message: string, options: { silent?: boolean } = {}): void {
    if (this.stopMessage !== undefined) return;
    this.stopMessage = message;
    if (!options.silent) this.options.onEvent?.({ type: "quota", message });
  }

  wrap(client: LlmClient): LlmClient {
    return { model: client.model, stream: (request, signal) => this.stream(client, request, signal) };
  }

  private pause(delayMs: number, cause: "provider" | "connection" = "provider"): void {
    const until = this.options.now() + delayMs;
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    this.options.onEvent?.({ type: "throttle", delayMs, pausedUntil: until, cause });
  }

  /**
   * Connection errors in a cluster mean that the machine or the provider cannot take this many connections at once (or something is wrong with the network);
   * replacing the failed agents at once only adds more connections. So a cluster is treated like a throttle. One error alone is not: the framework retries it.
   */
  private noteConnectionError(): void {
    if (this.connectionCluster.note(this.options.now())) this.pause(this.options.defaultPauseMs, "connection");
  }

  private async admit(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (this.stopMessage !== undefined) throw new ProviderError("quota", this.stopMessage);
      const waitMs = this.pausedUntil - this.options.now();
      if (waitMs <= 0) break;
      await this.options.sleep(waitMs, signal);
    }
    const reason = this.options.refusal?.();
    if (reason === undefined) return;
    this.options.onEvent?.({ type: "refused", reason });
    throw new ProviderError("quota", reason);
  }

  private async *stream(client: LlmClient, request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
    await this.admit(signal);
    this.inflightCount += 1;
    const startedAt = this.options.now();
    try {
      for await (const event of client.stream(request, signal)) {
        if (event.type === "usage") this.options.onEvent?.({ type: "usage", usage: event.usage, latencyMs: this.options.now() - startedAt });
        yield event;
      }
    } catch (error) {
      this.learnFrom(error);
      throw error;
    } finally {
      this.inflightCount -= 1;
    }
  }

  private learnFrom(error: unknown): void {
    if (!(error instanceof ProviderError)) return;
    if (error.kind === "quota") this.stop(error.message);
    else if (THROTTLE_KINDS.has(error.kind)) this.pause(error.retryAfterMs ?? this.options.defaultPauseMs);
    else if (error.kind === "network") this.noteConnectionError();
  }
}
