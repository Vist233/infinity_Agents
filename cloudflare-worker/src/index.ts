import type { Env } from "./env";
import { errorJson, json } from "./http";
import { handleLogin, handleCallback, handleLogout, resolveUser, type AuthedUser } from "./auth";
import {
  createSession,
  getSessions,
  getSessionMessages,
  updateSessionTitle,
  removeSession
} from "./sessions";
import { handleChat } from "./chat";
import { currentDailyUsage } from "./quota";
import {
  handleAuthCallback as handleImageJudgeAuthCallback,
  handleDesktopAuthorize as handleImageJudgeDesktopAuthorize,
  handleDesktopLogout as handleImageJudgeDesktopLogout,
  handleDesktopRefresh as handleImageJudgeDesktopRefresh,
  handleDesktopToken as handleImageJudgeDesktopToken,
} from "./imagejudge/auth";
import { handleEvaluate as handleImageJudgeEvaluate } from "./imagejudge/evaluate";
import type { Env as ImageJudgeEnv } from "./imagejudge/types";

export { ImageJudgeUserConcurrencyLock } from "./imagejudge/ratelimit";

const IMAGE_JUDGE_PREFIX = "/image-judge";

function imageJudgeEnv(env: Env): ImageJudgeEnv {
  return {
    DB: env.IMAGE_JUDGE_DB,
    KV: env.IMAGE_JUDGE_KV,
    USER_LOCK: env.IMAGE_JUDGE_USER_LOCK,
    ZHANG_AUTH_ISSUER: env.IMAGE_JUDGE_ZHANG_AUTH_ISSUER,
    OIDC_CLIENT_ID: env.IMAGE_JUDGE_OIDC_CLIENT_ID,
    OIDC_REDIRECT_URI: env.IMAGE_JUDGE_OIDC_REDIRECT_URI,
    DASHSCOPE_BASE_URL: env.IMAGE_JUDGE_DASHSCOPE_BASE_URL,
    MODEL_ID: env.IMAGE_JUDGE_MODEL_ID,
    DAILY_QUOTA: env.IMAGE_JUDGE_DAILY_QUOTA,
    ACCESS_TOKEN_TTL_SECONDS: env.IMAGE_JUDGE_ACCESS_TOKEN_TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS: env.IMAGE_JUDGE_REFRESH_TOKEN_TTL_SECONDS,
    MAX_IMAGE_BYTES: env.IMAGE_JUDGE_MAX_IMAGE_BYTES,
    ZHANG_AUTH_CLIENT_SECRET: env.IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET ?? "",
    TOKEN_SIGNING_SECRET: env.IMAGE_JUDGE_TOKEN_SIGNING_SECRET ?? "",
    DASHSCOPE_API_KEY: env.IMAGE_JUDGE_DASHSCOPE_API_KEY,
  };
}

function imageJudgeNotConfigured(message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "IMAGE_JUDGE_NOT_CONFIGURED",
        message,
        retryable: false,
      },
    }),
    { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
  );
}

async function handleImageJudge(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.slice(IMAGE_JUDGE_PREFIX.length) || "/";
  const method = request.method;

  if (method === "GET" && pathname === "/healthz") {
    return json({
      ok: true,
      service: "image-judge",
      platform_model_configured: Boolean(env.IMAGE_JUDGE_DASHSCOPE_API_KEY),
    });
  }

  const moduleEnv = imageJudgeEnv(env);
  if (!moduleEnv.TOKEN_SIGNING_SECRET || !moduleEnv.ZHANG_AUTH_CLIENT_SECRET) {
    return imageJudgeNotConfigured("ImageJudge 平台认证尚未配置");
  }

  if (pathname === "/desktop/authorize" && method === "GET") {
    return handleImageJudgeDesktopAuthorize(request, moduleEnv);
  }
  if (pathname === "/auth/callback" && method === "GET") {
    return handleImageJudgeAuthCallback(request, moduleEnv);
  }
  if (pathname === "/desktop/token" && method === "POST") {
    return handleImageJudgeDesktopToken(request, moduleEnv);
  }
  if (pathname === "/desktop/refresh" && method === "POST") {
    return handleImageJudgeDesktopRefresh(request, moduleEnv);
  }
  if (pathname === "/desktop/logout" && method === "POST") {
    return handleImageJudgeDesktopLogout(request, moduleEnv);
  }
  if (pathname === "/api/v1/evaluate" && method === "POST") {
    if (!moduleEnv.DASHSCOPE_API_KEY) {
      return imageJudgeNotConfigured("ImageJudge 平台模型未配置；当前请使用本地 BYOK 模式");
    }
    return handleImageJudgeEvaluate(request, moduleEnv);
  }
  return errorJson("Not found", 404, "NOT_FOUND");
}

/**
 * Apply a Set-Cookie header (produced by a token refresh during resolveUser) to
 * an already-built Response without mutating its body.
 */
function withCookie(response: Response, setCookie?: string): Response {
  if (!setCookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", setCookie);
  return new Response(response.body, { status: response.status, headers });
}

/** GET /api/me — current user + today's quota usage. */
async function handleMe(env: Env, user: AuthedUser): Promise<Response> {
  const usage = await currentDailyUsage(env, user.userId);
  return json({
    user: { id: user.userId, email: user.email },
    quota: { used: usage.count, limit: usage.limit }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === IMAGE_JUDGE_PREFIX || pathname.startsWith(`${IMAGE_JUDGE_PREFIX}/`)) {
      return handleImageJudge(request, env);
    }

    // Health check (unauthenticated).
    if (method === "GET" && pathname === "/health") {
      return json({ status: "ok", service: "infinity-agents-edge" });
    }

    // --- Auth routes (unauthenticated) ---
    if (method === "GET" && pathname === "/auth/login") {
      return await handleLogin(request, env);
    }
    if (method === "GET" && pathname === "/auth/callback") {
      return handleCallback(request, env);
    }
    if (method === "POST" && pathname === "/auth/logout") {
      return handleLogout(request, env);
    }

    // --- Protected API routes ---
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const resolved = await resolveUser(request, env);
      if (!resolved) {
        return errorJson("Authentication required", 401, "UNAUTHENTICATED");
      }
      const { user, setCookie } = resolved;

      // GET /api/me
      if (method === "GET" && pathname === "/api/me") {
        return withCookie(await handleMe(env, user), setCookie);
      }

      // /api/sessions collection
      if (pathname === "/api/sessions") {
        if (method === "POST") return withCookie(await createSession(env, user), setCookie);
        if (method === "GET") return withCookie(await getSessions(env, user), setCookie);
        return withCookie(errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED"), setCookie);
      }

      // /api/sessions/:id and sub-resources
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/messages|\/title)?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const sub = sessionMatch[2];

        if (sub === "/messages" && method === "GET") {
          return withCookie(await getSessionMessages(env, user, sessionId), setCookie);
        }
        if (sub === "/title" && method === "PATCH") {
          return withCookie(await updateSessionTitle(env, user, sessionId, request), setCookie);
        }
        if (!sub && method === "DELETE") {
          return withCookie(await removeSession(env, user, sessionId), setCookie);
        }
        return withCookie(errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED"), setCookie);
      }

      // POST /api/chat (SSE)
      if (pathname === "/api/chat" && method === "POST") {
        return withCookie(await handleChat(request, env, user), setCookie);
      }

      return withCookie(errorJson("Not found", 404, "NOT_FOUND"), setCookie);
    }

    // --- Everything else: serve the static frontend (Next export). ---
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
