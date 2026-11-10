import { describe, expect, it } from "vitest";
import { NeverFitsError, ResourcePool } from "../src/resource-pool.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ResourcePool", () => {
  it("rejects capacities that are not at least one", () => {
    expect(() => new ResourcePool({ gpu: 0 })).toThrow(RangeError);
    expect(() => new ResourcePool({ gpu: Number.NaN })).toThrow(RangeError);
    expect(() => new ResourcePool({ gpu: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("grants amounts of several resources at once and tracks use", async () => {
    const pool = new ResourcePool({ gpu: 2, cpu: 8 });
    const release = await pool.acquire({ gpu: 1, cpu: 4 });
    expect(pool.inUse("gpu")).toBe(1);
    expect(pool.inUse("cpu")).toBe(4);
    release();
    expect(pool.inUse("gpu")).toBe(0);
    expect(pool.inUse("nothing")).toBe(0);
  });

  it("refuses at once what can never fit: unknown resource, too much, empty, zero, negative, not a number", () => {
    const pool = new ResourcePool({ gpu: 2 });
    for (const needs of [{ tpu: 1 }, { gpu: 3 }, {}, { gpu: 0 }, { gpu: -1 }, { gpu: Number.NaN }]) {
      expect(() => pool.acquire(needs)).toThrow(NeverFitsError);
    }
  });

  it("never lets use go above the capacity, however many ask", async () => {
    const pool = new ResourcePool({ gpu: 2 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 9 }, () =>
        pool.run({ gpu: 1 }, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("is strictly first come first served: a small request does not overtake a waiting big one", async () => {
    const pool = new ResourcePool({ gpu: 2 });
    const first = await pool.acquire({ gpu: 1 });
    const order: string[] = [];
    const big = pool.acquire({ gpu: 2 }).then((release) => {
      order.push("big");
      release();
    });
    const small = pool.acquire({ gpu: 1 }).then((release) => {
      order.push("small");
      release();
    });
    await tick();
    expect(order).toEqual([]); // the small one could fit but waits behind the big one
    first();
    await Promise.all([big, small]);
    expect(order).toEqual(["big", "small"]);
  });

  it("gets everything or nothing: a request that needs two things does not hold one while it waits", async () => {
    const pool = new ResourcePool({ gpu: 1, cpu: 2 });
    const cpuHolder = await pool.acquire({ cpu: 2 });
    const both = pool.acquire({ gpu: 1, cpu: 1 });
    await tick();
    expect(pool.inUse("gpu")).toBe(0);
    cpuHolder();
    (await both)();
  });

  it("leaves the queue when aborted, and the request behind it is served if it fits", async () => {
    const pool = new ResourcePool({ gpu: 2 });
    const holder = await pool.acquire({ gpu: 1 });
    const controller = new AbortController();
    const big = pool.acquire({ gpu: 2 }, controller.signal);
    const small = pool.acquire({ gpu: 1 });
    await tick();
    expect(pool.waiting).toBe(2);
    controller.abort(new Error("cancelled"));
    await expect(big).rejects.toThrow("cancelled");
    (await small)();
    holder();
    expect(pool.waiting).toBe(0);
    expect(pool.inUse("gpu")).toBe(0);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const pool = new ResourcePool({ gpu: 1 });
    const controller = new AbortController();
    controller.abort(new Error("already"));
    await expect(pool.acquire({ gpu: 1 }, controller.signal)).rejects.toThrow("already");
    expect(pool.inUse("gpu")).toBe(0);
  });

  it("releases when the work throws, and a double release is harmless", async () => {
    const pool = new ResourcePool({ gpu: 1 });
    await expect(pool.run({ gpu: 1 }, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(pool.inUse("gpu")).toBe(0);
    const release = await pool.acquire({ gpu: 1 });
    release();
    release();
    expect(pool.inUse("gpu")).toBe(0);
  });

  it("does not count the wait inside the work's own timeout", async () => {
    const pool = new ResourcePool({ gpu: 1 });
    const holder = await pool.acquire({ gpu: 1 });
    let startedAt = -1;
    const started = pool.run({ gpu: 1 }, async () => {
      startedAt = Date.now();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(startedAt).toBe(-1);
    holder();
    await started;
    expect(startedAt).toBeGreaterThan(0);
  });

  it("holds new grants while admission is closed, keeps the order, and serves them when it opens", async () => {
    const pool = new ResourcePool({ gpu: 2 });
    pool.closeAdmission();
    expect(pool.admitting).toBe(false);
    const order: number[] = [];
    const jobs = [1, 2].map((n) =>
      pool.acquire({ gpu: 1 }).then((release) => {
        order.push(n);
        release();
      }),
    );
    await tick();
    expect(order).toEqual([]);
    expect(pool.waiting).toBe(2);
    pool.openAdmission();
    await Promise.all(jobs);
    expect(order).toEqual([1, 2]);
  });

  it("lets holders that already run finish while admission is closed", async () => {
    const pool = new ResourcePool({ gpu: 1 });
    const release = await pool.acquire({ gpu: 1 });
    pool.closeAdmission();
    release();
    expect(pool.inUse("gpu")).toBe(0);
  });
});
