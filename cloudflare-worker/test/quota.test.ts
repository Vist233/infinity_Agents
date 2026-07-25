import { describe, expect, it } from "vitest";
import { consumeDailyQuota, currentDailyUsage, decrementDailyUsageSafe, shanghaiDay } from "../src/quota";
import { makeEnv } from "./fake-d1";

describe("shanghaiDay", () => {
  it("rolls the calendar day forward for UTC+8", () => {
    // 2026-07-24T20:00:00Z is 2026-07-25 04:00 in Shanghai.
    expect(shanghaiDay(new Date("2026-07-24T20:00:00Z"))).toBe("2026-07-25");
    // 2026-07-24T10:00:00Z is still 2026-07-24 18:00 in Shanghai.
    expect(shanghaiDay(new Date("2026-07-24T10:00:00Z"))).toBe("2026-07-24");
  });
});

describe("daily quota", () => {
  it("allows up to the limit and rejects the overflow request", async () => {
    const { env } = makeEnv({ DAILY_QUOTA: "3" });
    const user = "user-1";

    for (let i = 1; i <= 3; i += 1) {
      const r = await consumeDailyQuota(env, user);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
    }

    const overflow = await consumeDailyQuota(env, user);
    expect(overflow.allowed).toBe(false);
    expect(overflow.reason).toBe("daily_quota_exceeded");
    expect(overflow.limit).toBe(3);
  });

  it("reports current usage and refunds a unit on failure", async () => {
    const { env } = makeEnv({ DAILY_QUOTA: "5" });
    const user = "user-2";

    await consumeDailyQuota(env, user);
    await consumeDailyQuota(env, user);
    expect((await currentDailyUsage(env, user)).count).toBe(2);

    await decrementDailyUsageSafe(env, user);
    expect((await currentDailyUsage(env, user)).count).toBe(1);
  });

  it("keeps quota per-user isolated", async () => {
    const { env } = makeEnv({ DAILY_QUOTA: "2" });
    await consumeDailyQuota(env, "a");
    await consumeDailyQuota(env, "a");
    const aOverflow = await consumeDailyQuota(env, "a");
    const bFirst = await consumeDailyQuota(env, "b");
    expect(aOverflow.allowed).toBe(false);
    expect(bFirst.allowed).toBe(true);
  });
});
