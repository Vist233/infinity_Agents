import { describe, expect, it } from "vitest";
import { Pool } from "../src/pool.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Pool", () => {
  it("rejects a capacity below one", () => {
    expect(() => new Pool(0)).toThrow(RangeError);
  });

  it("never lets more than capacity hold a place", async () => {
    const pool = new Pool(2);
    let active = 0;
    let peak = 0;
    const job = () =>
      pool.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        active -= 1;
      });
    await Promise.all(Array.from({ length: 10 }, job));
    expect(peak).toBe(2);
    expect(pool.inUse).toBe(0);
  });

  it("serves waiters in arrival order", async () => {
    const pool = new Pool(1);
    const order: number[] = [];
    const first = await pool.acquire();
    const waiters = [1, 2, 3].map((n) =>
      pool.acquire().then((release) => {
        order.push(n);
        release();
      }),
    );
    first();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the place when the work throws", async () => {
    const pool = new Pool(1);
    await expect(pool.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(pool.inUse).toBe(0);
  });

  it("makes a double release harmless", async () => {
    const pool = new Pool(1);
    const release = await pool.acquire();
    release();
    release();
    expect(pool.inUse).toBe(0);
    const again = await pool.acquire();
    const second = pool.acquire();
    expect(pool.waiting).toBe(1);
    again();
    (await second)();
  });

  it("leaves the line when aborted while waiting, without taking a place", async () => {
    const pool = new Pool(1);
    const holder = await pool.acquire();
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal);
    expect(pool.waiting).toBe(1);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(pool.waiting).toBe(0);
    holder();
    expect(pool.inUse).toBe(0);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const pool = new Pool(1);
    const controller = new AbortController();
    controller.abort(new Error("already"));
    await expect(pool.acquire(controller.signal)).rejects.toThrow("already");
    expect(pool.inUse).toBe(0);
  });

  it("does not count the wait inside the work's own timeout", async () => {
    const pool = new Pool(1);
    const holder = await pool.acquire();
    let startedAt = -1;
    const started = pool.run(async () => {
      startedAt = Date.now();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(startedAt).toBe(-1);
    holder();
    await started;
    expect(startedAt).toBeGreaterThan(0);
  });
});
