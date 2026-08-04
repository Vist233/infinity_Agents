/** 用量控制：D1 每日额度 + Durable Object 每用户并发 1 lease（文档 §9.2）。 */
import type { Env } from "./types";
import { utcDateString } from "./types";

export interface QuotaCheck {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/** 查询当前 UTC 日剩余额度（不扣减）。 */
export async function checkQuota(env: Env, userSub: string): Promise<QuotaCheck> {
  const limit = parseInt(env.DAILY_QUOTA || "30", 10);
  const date = utcDateString();
  const row = await env.DB.prepare(
    `SELECT accepted_count FROM usage_daily WHERE user_sub = ?1 AND quota_date = ?2`
  )
    .bind(userSub, date)
    .first<{ accepted_count: number }>();
  const used = row?.accepted_count ?? 0;
  return {
    allowed: used < limit,
    limit,
    remaining: Math.max(0, limit - used),
    resetSeconds: secondsUntilReset(),
  };
}

/** 原子递增额度计数（(user_sub, quota_date) 唯一键）。返回递增后是否仍在额度内。 */
export async function incrementQuota(env: Env, userSub: string): Promise<boolean> {
  const limit = parseInt(env.DAILY_QUOTA || "30", 10);
  const date = utcDateString();
  const result = await env.DB.prepare(
    `INSERT INTO usage_daily (user_sub, quota_date, accepted_count) VALUES (?1, ?2, 1)
     ON CONFLICT(user_sub, quota_date) DO UPDATE SET accepted_count = accepted_count + 1
     RETURNING accepted_count`
  )
    .bind(userSub, date)
    .first<{ accepted_count: number }>();
  return (result?.accepted_count ?? limit + 1) <= limit;
}

function secondsUntilReset(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.floor((next - now.getTime()) / 1000));
}

// ---------------------------------------------------------------------------
// Durable Object：每用户并发 1 的强一致 lease
// ---------------------------------------------------------------------------
const LEASE_MAX_MS = 300_000; // 最长占用 5 分钟，防止客户端崩溃后死锁

export class ImageJudgeUserConcurrencyLock {
  private state: DurableObjectState;
  private leaseUntil = 0;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<number>("lease_until");
      this.leaseUntil = stored ?? 0;
    });

    if (url.pathname === "/acquire") {
      const now = Date.now();
      if (this.leaseUntil > now) {
        const retryAfter = Math.max(1, Math.ceil((this.leaseUntil - now) / 1000));
        return new Response(JSON.stringify({ ok: false, retry_after: retryAfter }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const duration = Math.min(LEASE_MAX_MS, Number(url.searchParams.get("ttl") || LEASE_MAX_MS));
      this.leaseUntil = now + duration;
      await this.state.storage.put("lease_until", this.leaseUntil);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/release") {
      this.leaseUntil = 0;
      await this.state.storage.put("lease_until", 0);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }
}

/** 获取用户并发 lease；失败返回 null 与 Retry-After 秒数。 */
export async function acquireLease(
  env: Env,
  userSub: string,
  ttlMs: number
): Promise<{ ok: boolean; retryAfter: number }> {
  const id = env.USER_LOCK.idFromName(userSub);
  const stub = env.USER_LOCK.get(id);
  const resp = await stub.fetch(`https://lock/acquire?ttl=${ttlMs}`);
  const data = (await resp.json()) as { ok: boolean; retry_after?: number };
  return { ok: data.ok, retryAfter: data.retry_after ?? 5 };
}

export async function releaseLease(env: Env, userSub: string): Promise<void> {
  try {
    const id = env.USER_LOCK.idFromName(userSub);
    const stub = env.USER_LOCK.get(id);
    await stub.fetch("https://lock/release");
  } catch {
    // 释放失败由 lease 超时兜底
  }
}
