import type { Clock } from "./clock.ts";

export const MAX_RESCUES = 3;

export const RESCUE_MESSAGE =
  "You seem stuck: nothing has happened for a long time. Say in one sentence where you are, then choose a different approach and continue.";

export type StuckAction = { type: "rescue"; agent: number; rescue: number; message: string } | { type: "stop"; agent: number };

export interface StuckOptions {
  clock: Clock;
  /** Silence longer than this makes a running agent stuck. */
  stuckAfterMs: number;
  /**
   * True while the agent is excused: it waits in the Gate or in a pool, a tool of its own is running, or it has a background process.
   * An excused agent is never stuck.
   */
  isExcused: (agent: number) => boolean;
}

interface Tracked {
  lastEventAt: number;
  rescues: number;
}

/**
 * Finds stuck agents. Stuck = running, silent for `stuckAfterMs`, and not excused.
 * Each stuck is answered with a rescue (cancel and start again with a message), at most MAX_RESCUES times per agent;
 * the next time it is stuck the answer is stop, and the ladder starts a new agent in its place.
 */
export class StuckDetector {
  private readonly tracked = new Map<number, Tracked>();

  private readonly options: StuckOptions;

  constructor(options: StuckOptions) {
    this.options = options;
  }

  register(agent: number): void {
    this.tracked.set(agent, { lastEventAt: this.options.clock.now(), rescues: 0 });
  }

  forget(agent: number): void {
    this.tracked.delete(agent);
  }

  /** Call for every event of the agent (any sign of life). */
  touch(agent: number): void {
    const entry = this.tracked.get(agent);
    if (entry) entry.lastEventAt = this.options.clock.now();
  }

  /** The actions to take now. Rescued agents count as touched, so they get a full silence period to react. */
  check(): StuckAction[] {
    const now = this.options.clock.now();
    const actions: StuckAction[] = [];
    for (const [agent, entry] of this.tracked) {
      if (now - entry.lastEventAt < this.options.stuckAfterMs || this.options.isExcused(agent)) continue;
      if (entry.rescues >= MAX_RESCUES) {
        this.tracked.delete(agent);
        actions.push({ type: "stop", agent });
        continue;
      }
      entry.rescues += 1;
      entry.lastEventAt = now;
      actions.push({ type: "rescue", agent, rescue: entry.rescues, message: RESCUE_MESSAGE });
    }
    return actions;
  }

  rescuesOf(agent: number): number {
    return this.tracked.get(agent)?.rescues ?? 0;
  }
}
