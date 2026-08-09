import type { Env } from "./env";
import { decrementDailyUsage, getDailyUsage, incrementDailyUsage } from "./db";

/** Current calendar day in Asia/Shanghai (UTC+8), formatted YYYY-MM-DD. */
export function shanghaiDay(date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export interface QuotaResult {
  allowed: boolean;
  reason?: "rate_limited" | "daily_quota_exceeded";
  count?: number;
  limit?: number;
}

/** Enforce per-user rate limit (5/min) without consuming daily quota. */
export async function checkRateLimit(env: Env, userId: string): Promise<boolean> {
  try {
    const { success } = await env.CHAT_RATE_LIMITER.limit({ key: userId });
    return success;
  } catch {
    // A missing rate-limit binding must not silently disable production
    // protection. Local tests provide a real fake binding, so fail closed is
    // safe for both deployment and development.
    return false;
  }
}

/**
 * Atomically consume one unit of the daily conversation quota. Returns whether
 * the request is allowed. Only call this once a message is accepted for
 * processing; tool calls / retries must NOT call this.
 */
export async function consumeDailyQuota(env: Env, userId: string): Promise<QuotaResult> {
  const limit = Number(env.DAILY_QUOTA) || 20;
  const day = shanghaiDay();
  const count = await incrementDailyUsage(env, userId, day);
  if (count > limit) {
    return { allowed: false, reason: "daily_quota_exceeded", count: count - 1, limit };
  }
  return { allowed: true, count, limit };
}

export async function currentDailyUsage(env: Env, userId: string): Promise<{ count: number; limit: number }> {
  const limit = Number(env.DAILY_QUOTA) || 20;
  const count = await getDailyUsage(env, userId, shanghaiDay());
  return { count, limit };
}

/** Refund one quota unit (best-effort) if a request failed after consumption. */
export async function decrementDailyUsageSafe(env: Env, userId: string): Promise<void> {
  try {
    await decrementDailyUsage(env, userId, shanghaiDay());
  } catch {
    // ignore
  }
}
