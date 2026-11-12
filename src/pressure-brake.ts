import type { MachineSample } from "./machine-summary.ts";

/**
 * The pressure brake (docs/16 section D, docs/18): a pure policy. Readings go in, a decision to hold the ladder (or let it go) comes out; it knows nothing
 * of the machine, the clock or the run.
 */
export interface BrakeLimits {
  /** Load average (1 minute) per core above which the machine counts as over the limit (default 1.0). */
  loadPerCore?: number;
  /** CPU pressure ("some", 10 s average, percent) above which it counts as over the limit (default 40). */
  pressure10?: number;
  /** Readings in a row, over the limit to put the brake on and under it to take it off (default 3). */
  readings?: number;
}

const DEFAULT_BRAKE: Required<BrakeLimits> = { loadPerCore: 1, pressure10: 40, readings: 3 };

/** Decides from successive readings when the ladder should be held. Pure state; the component acts on what it answers. */
export class PressureBrake {
  private readonly limits: Required<BrakeLimits>;
  private on = false;
  private streak = 0;

  constructor(limits: BrakeLimits = {}) {
    this.limits = { ...DEFAULT_BRAKE, ...limits };
  }

  get active(): boolean {
    return this.on;
  }

  /** Is this reading over the limit? */
  over(sample: Pick<MachineSample, "cores" | "load1" | "cpuPressure10">): boolean {
    return sample.load1 / Math.max(1, sample.cores) > this.limits.loadPerCore || (sample.cpuPressure10 ?? 0) > this.limits.pressure10;
  }

  /** Feeds a reading; returns the new state when it changed (on after enough readings over the limit in a row, off after as many under it), else undefined. */
  update(sample: Pick<MachineSample, "cores" | "load1" | "cpuPressure10">): boolean | undefined {
    this.streak = this.over(sample) === this.on ? 0 : this.streak + 1;
    if (this.streak < this.limits.readings) return undefined;
    this.streak = 0;
    this.on = !this.on;
    return this.on;
  }
}
