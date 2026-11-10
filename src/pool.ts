/** A FIFO semaphore: at most `capacity` holders at a time; waiters are served in arrival order. */
export type Release = () => void;

interface Waiter {
  grant: (release: Release) => void;
  fail: (reason: unknown) => void;
  detach: () => void;
}

export class Pool {
  private held = 0;
  private readonly queue: Waiter[] = [];

  readonly capacity: number;

  constructor(capacity: number) {
    if (!(capacity >= 1)) throw new RangeError(`Pool capacity must be at least 1, got ${capacity}`);
    this.capacity = capacity;
  }

  get inUse(): number {
    return this.held;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Resolves with a release function once a place is free. Rejects, and leaves the line, when the signal aborts. */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.held < this.capacity) return Promise.resolve(this.take());
    return new Promise<Release>((resolve, reject) => {
      const onAbort = () => {
        this.leaveLine(waiter);
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        grant: resolve,
        fail: reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /** Runs `work` while holding a place. The wait for the place is not part of `work`, so a timeout inside `work` does not count it. */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  private take(): Release {
    this.held += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held -= 1;
      this.serveNext();
    };
  }

  private serveNext(): void {
    const next = this.queue.shift();
    if (!next) return;
    next.detach();
    next.grant(this.take());
  }

  private leaveLine(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
  }
}

/** The pool size to use when a task does not set one: the number of CPU cores. */
export function defaultLeanPoolSize(cpuCount: number): number {
  return Math.max(1, cpuCount);
}
