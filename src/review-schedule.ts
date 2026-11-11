/** When agents are due for a branch review (pure; no clock). */

/**
 * Who is due for a review and when (docs/10 section 1.1). Agent `n` has the slot `(n - 1) mod ceiling` and is due at
 * `start + slot / ceiling x T + k x T`, k = 1, 2, ...: with 30 agents and T = 7 minutes about one review every 14 seconds, never all at once.
 * Pure: it knows no clock; the caller passes the time.
 */
export class ReviewScheduler {
  private readonly everyMs: number;
  private readonly ceiling: number;
  private readonly started = new Map<number, number>();
  private readonly round = new Map<number, number>();

  constructor(everyMs: number, ceiling: number) {
    if (!(everyMs > 0) || !(ceiling >= 1)) throw new RangeError("everyMs must be positive and ceiling at least 1");
    this.everyMs = everyMs;
    this.ceiling = ceiling;
  }

  slot(agent: number): number {
    return (agent - 1) % this.ceiling;
  }

  register(agent: number, startedAt: number): void {
    this.started.set(agent, startedAt);
    this.round.set(agent, 1);
  }

  forget(agent: number): void {
    this.started.delete(agent);
    this.round.delete(agent);
  }

  nextDue(agent: number): number | undefined {
    const start = this.started.get(agent);
    if (start === undefined) return undefined;
    return start + (this.slot(agent) / this.ceiling) * this.everyMs + (this.round.get(agent) ?? 1) * this.everyMs;
  }

  /** The agents whose time has come, the longest overdue first. Asking does not use the due time up: a skipped review is offered again at the next check. */
  dueAgents(now: number): number[] {
    return [...this.started.keys()]
      .map((agent) => ({ agent, due: this.nextDue(agent) as number }))
      .filter((entry) => entry.due <= now)
      .sort((a, b) => a.due - b.due || a.agent - b.agent)
      .map((entry) => entry.agent);
  }

  /** The review of this agent has begun: the next due time is the first one after `now`, so one due time never fires twice. */
  begun(agent: number, now: number): void {
    let round = this.round.get(agent) ?? 1;
    while ((this.nextDueFor(agent, round) as number) <= now) round += 1;
    this.round.set(agent, round);
  }

  private nextDueFor(agent: number, round: number): number {
    return (this.started.get(agent) as number) + (this.slot(agent) / this.ceiling) * this.everyMs + round * this.everyMs;
  }
}
