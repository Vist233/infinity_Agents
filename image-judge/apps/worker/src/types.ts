/** Worker 绑定与环境类型（文档 §9.3）。 */

export interface Env {
  // Secrets（wrangler secret put；绝不写入普通 vars）
  DASHSCOPE_API_KEY?: string;
  ZHANG_AUTH_CLIENT_SECRET: string;
  TOKEN_SIGNING_SECRET: string;

  // 绑定
  DB: D1Database;
  KV: KVNamespace;
  USER_LOCK: DurableObjectNamespace;

  // 普通配置
  ZHANG_AUTH_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_REDIRECT_URI: string;
  DASHSCOPE_BASE_URL: string;
  MODEL_ID: string;
  DAILY_QUOTA: string;
  ACCESS_TOKEN_TTL_SECONDS: string;
  REFRESH_TOKEN_TTL_SECONDS: string;
  MAX_IMAGE_BYTES: string;
}

/** 标准错误响应（文档 §19.3）。 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  requestId = "",
  headers: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({
      error: { code, message, retryable, request_id: requestId },
    }),
    { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } }
  );
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

export function utcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 到下一个 UTC 日的秒数。 */
export function secondsUntilNextUtcDay(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.floor((next - now.getTime()) / 1000));
}
