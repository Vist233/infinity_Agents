/** Measures one rung of the ladder: what happened between two changes of the number of agents. */
export interface RungStats {
  replies: number;
  throttles: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  tokensPerMinute: number;
}

export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export class RungMeter {
  private startedAt: number;
  private latencies: number[] = [];
  private tokens = 0;
  private throttleCount = 0;

  constructor(now: number) {
    this.startedAt = now;
  }

  recordReply(latencyMs: number, tokens: number): void {
    this.latencies.push(latencyMs);
    this.tokens += tokens;
  }

  recordThrottle(): void {
    this.throttleCount += 1;
  }

  /** The numbers of the rung that ends now; starts a new rung. */
  closeRung(now: number): RungStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const minutes = Math.max(now - this.startedAt, 1) / 60_000;
    const stats: RungStats = {
      replies: sorted.length,
      throttles: this.throttleCount,
      latencyP50Ms: percentile(sorted, 0.5),
      latencyP95Ms: percentile(sorted, 0.95),
      tokensPerMinute: this.tokens / minutes,
    };
    this.startedAt = now;
    this.latencies = [];
    this.tokens = 0;
    this.throttleCount = 0;
    return stats;
  }
}
