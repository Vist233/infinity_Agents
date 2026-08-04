/** ImageJudge Worker 子模块的环境适配层。资源使用独立绑定，避免污染 Infinity Agent 数据。 */
export interface Env {
  DASHSCOPE_API_KEY?: string;
  ZHANG_AUTH_CLIENT_SECRET: string;
  TOKEN_SIGNING_SECRET: string;

  DB: D1Database;
  KV: KVNamespace;
  USER_LOCK: DurableObjectNamespace;

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
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export function utcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function secondsUntilNextUtcDay(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.floor((next - now.getTime()) / 1000));
}
