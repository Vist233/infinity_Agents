import type { Clock } from "../../src/clock.ts";

interface Sleeper {
  wakeAt: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/** A clock that moves only when the test says so. */
export class FakeClock implements Clock {
  private time = 0;
  private sleepers: Sleeper[] = [];

  now(): number {
    return this.time;
  }

  get sleeping(): number {
    return this.sleepers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const sleeper: Sleeper = { wakeAt: this.time + ms, resolve, reject };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.sleepers = this.sleepers.filter((other) => other !== sleeper);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  /** Moves time forward and wakes every sleeper that is due, earliest first. Lets promise callbacks run between wake-ups. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.sleepers.filter((sleeper) => sleeper.wakeAt <= target).sort((a, b) => a.wakeAt - b.wakeAt)[0];
      if (!due) break;
      this.sleepers = this.sleepers.filter((sleeper) => sleeper !== due);
      this.time = Math.max(this.time, due.wakeAt);
      due.resolve();
      await flushPromises();
    }
    this.time = target;
    await flushPromises();
  }
}

export async function flushPromises(): Promise<void> {
  for (let round = 0; round < 20; round++) await new Promise<void>((resolve) => setImmediate(resolve));
}
