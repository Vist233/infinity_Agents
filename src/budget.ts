import type { Usage } from "sakura-agent";

/** Every kind of token counts in full, cache reads included. */
export function totalTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * A plain counter over the tokens of every request.
 * Soft stop rule: refuse to start a request when  used + inflight x mean request size >= budget.
 * `inflight` counts the request that is about to start, so with one agent the margin is one mean request.
 * No budget (undefined) never stops.
 */
export class Budget {
  private used = 0;
  private requests = 0;

  private readonly limit: number | undefined;
  private readonly inflight: () => number;

  constructor(limit: number | undefined, inflight: () => number) {
    if (limit !== undefined && !(limit > 0)) throw new RangeError(`Budget must be positive, got ${limit}`);
    this.limit = limit;
    this.inflight = inflight;
  }

  record(usage: Usage): void {
    this.used += totalTokens(usage);
    this.requests += 1;
  }

  /** Sets the counters again after a restart of the program (the totals come from the state file). */
  restore(tokensUsed: number, requests: number): void {
    this.used = tokensUsed;
    this.requests = requests;
  }

  get requestCount(): number {
    return this.requests;
  }

  get tokensUsed(): number {
    return this.used;
  }

  get meanRequestTokens(): number {
    return this.requests === 0 ? 0 : this.used / this.requests;
  }

  /** The reason to refuse a new request, or undefined when it may start. */
  refusal(): string | undefined {
    if (this.limit === undefined) return undefined;
    const projected = this.used + (this.inflight() + 1) * this.meanRequestTokens;
    if (projected < this.limit) return undefined;
    return `token budget reached: ${this.used} used, ${Math.round(projected)} projected, limit ${this.limit}`;
  }
}
