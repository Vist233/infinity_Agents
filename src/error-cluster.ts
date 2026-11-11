/**
 * Counts events inside a sliding window. `note` says true when `threshold` events have happened within `windowMs`, and starts counting again.
 * Pure: the caller passes the time.
 */
export class ClusterDetector {
  private times: number[] = [];
  private readonly threshold: number;
  private readonly windowMs: number;

  constructor(threshold: number, windowMs: number) {
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  note(now: number): boolean {
    this.times = [...this.times.filter((time) => now - time < this.windowMs), now];
    if (this.times.length < this.threshold) return false;
    this.times = [];
    return true;
  }
}
