/**
 * Named resources with quantities (`cpu`, `gpu`, ...). A request names what it needs, waits in one fair queue and gets everything at once or nothing.
 * `Pool` (one kind, one place per holder) stays for Lean; this is for jobs that need several things in amounts.
 */
export type Needs = Readonly<Record<string, number>>;
export type Release = () => void;

/** A request that can never be served, however long it waits. Thrown at once, not after a wait. */
export class NeverFitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeverFitsError";
  }
}

interface Waiter {
  needs: Needs;
  grant: (release: Release) => void;
  detach: () => void;
}

export class ResourcePool {
  private readonly capacities: Readonly<Record<string, number>>;
  private readonly used: Record<string, number> = {};
  private readonly queue: Waiter[] = [];
  private admissionOpen = true;

  constructor(capacities: Record<string, number>) {
    for (const [name, capacity] of Object.entries(capacities)) {
      if (!(capacity >= 1) || !Number.isFinite(capacity)) throw new RangeError(`Capacity of '${name}' must be a finite number of at least 1, got ${capacity}`);
    }
    this.capacities = { ...capacities };
    for (const name of Object.keys(capacities)) this.used[name] = 0;
  }

  inUse(name: string): number {
    return this.used[name] ?? 0;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Resolves with a release function once all of `needs` are free. Strict first-come-first-served: nobody overtakes the head of the queue,
   * so a big request is never starved by small ones. Rejects, and leaves the queue, when the signal aborts.
   */
  acquire(needs: Needs, signal?: AbortSignal): Promise<Release> {
    this.check(needs);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<Release>((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason);
        this.serve(); // the one behind may fit now
      };
      const waiter: Waiter = { needs, grant: resolve, detach: () => signal?.removeEventListener("abort", onAbort) };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      this.serve();
    });
  }

  /** Holds the resources while `work` runs. The wait is not part of `work`, so a timeout inside `work` never counts it. */
  async run<T>(needs: Needs, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(needs, signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** While closed (the machine is under pressure), nothing new is granted; running holders continue and the queue keeps its order. */
  closeAdmission(): void {
    this.admissionOpen = false;
  }

  openAdmission(): void {
    this.admissionOpen = true;
    this.serve();
  }

  get admitting(): boolean {
    return this.admissionOpen;
  }

  private check(needs: Needs): void {
    const entries = Object.entries(needs);
    if (entries.length === 0) throw new NeverFitsError("A request must name at least one resource");
    for (const [name, amount] of entries) {
      const capacity = this.capacities[name];
      if (capacity === undefined) throw new NeverFitsError(`Unknown resource '${name}'`);
      if (!Number.isFinite(amount) || amount <= 0) throw new NeverFitsError(`The amount of '${name}' must be a positive number, got ${amount}`);
      if (amount > capacity) throw new NeverFitsError(`'${name}': ${amount} requested but the capacity is ${capacity}`);
    }
  }

  private fits(needs: Needs): boolean {
    return Object.entries(needs).every(([name, amount]) => (this.used[name] ?? 0) + amount <= (this.capacities[name] ?? 0));
  }

  private serve(): void {
    while (this.admissionOpen) {
      const head = this.queue[0];
      if (!head || !this.fits(head.needs)) return;
      this.queue.shift();
      head.detach();
      head.grant(this.take(head.needs));
    }
  }

  private take(needs: Needs): Release {
    for (const [name, amount] of Object.entries(needs)) this.used[name] = (this.used[name] ?? 0) + amount;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const [name, amount] of Object.entries(needs)) this.used[name] = (this.used[name] ?? 0) - amount;
      this.serve();
    };
  }
}
