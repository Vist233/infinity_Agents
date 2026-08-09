import type { Env } from "./env";
import { errorJson, json } from "./http";
import { handleLogin, handleCallback, handleLogout, resolveUser, type AuthedUser } from "./auth";
import {
  createSession,
  getSessions,
  getSessionMessages,
  updateSessionTitle,
  removeSession,
} from "./sessions";
import { handleChat } from "./chat";
import { currentDailyUsage } from "./quota";
import { handleImageJudge } from "./image-judge";
import { handleTaskApi } from "./tasks";
import { handleWorkerControlApi } from "./worker-control";

export { ImageJudgeUserConcurrencyLock } from "./image-judge";

/**
 * Apply a Set-Cookie header produced by a token refresh to an existing
 * response without consuming or rebuilding its body.
 */
function withCookie(response: Response, setCookie?: string): Response {
  if (!setCookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", setCookie);
  return new Response(response.body, { status: response.status, headers });
}

/** GET /api/me — current user and today's quota usage. */
async function handleMe(env: Env, user: AuthedUser): Promise<Response> {
  const usage = await currentDailyUsage(env, user.userId);
  return json({
    user: { id: user.userId, email: user.email },
    quota: { used: usage.count, limit: usage.limit },
  });
}

/**
 * Infinity Edge routes both products from one Worker:
 *
 * - `/image-judge/*` is the isolated ImageJudge API namespace.
 * - `/auth/*` and `/api/*` are the PaperAgent session/auth API.
 * - all other GET/HEAD requests are static Next export assets.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "GET" && pathname === "/health") {
      return json({ status: "ok", service: "infinity-agents-edge" });
    }

    // ImageJudge has independent bindings and credentials. Keep this check
    // before the generic auth/API routes so its callback cannot be confused
    // with PaperAgent's callback.
    const isImageJudgeRoute =
      pathname === "/image-judge/healthz" ||
      pathname.startsWith("/image-judge/desktop/") ||
      pathname.startsWith("/image-judge/auth/") ||
      pathname.startsWith("/image-judge/api/");
    if (isImageJudgeRoute) {
      return handleImageJudge(request, env);
    }

    // PaperAgent authentication is cookie-backed and server-side. Tokens are
    // kept in the Infinity D1 session table; the browser only receives the
    // opaque `ia_session` cookie.
    if (method === "GET" && pathname === "/auth/login") {
      return handleLogin(request, env);
    }
    if (method === "GET" && pathname === "/auth/callback") {
      return handleCallback(request, env);
    }
    if (method === "POST" && pathname === "/auth/logout") {
      return handleLogout(request, env);
    }

    // Worker control is authenticated with a revocable per-machine bearer
    // credential, not with a browser OIDC cookie. Keep it ahead of the generic
    // `/api/*` user session resolver so a Worker can enroll/poll without ever
    // receiving browser-session semantics.
    if (pathname.startsWith("/api/worker/v1/")) {
      return handleWorkerControlApi(request, env);
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const resolved = await resolveUser(request, env);
      if (!resolved) {
        return errorJson("Authentication required", 401, "UNAUTHENTICATED");
      }
      const { user, setCookie } = resolved;

      if (method === "GET" && pathname === "/api/me") {
        return withCookie(await handleMe(env, user), setCookie);
      }

      const taskResponse = await handleTaskApi(request, env, user);
      if (taskResponse) return withCookie(taskResponse, setCookie);

      if (pathname === "/api/sessions") {
        if (method === "POST") return withCookie(await createSession(env, user), setCookie);
        if (method === "GET") return withCookie(await getSessions(env, user), setCookie);
        return withCookie(errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED"), setCookie);
      }

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

      if (pathname === "/api/chat" && method === "POST") {
        return withCookie(await handleChat(request, env, user), setCookie);
      }

      return withCookie(errorJson("Not found", 404, "NOT_FOUND"), setCookie);
    }

    if (method === "GET" || method === "HEAD") {
      return env.ASSETS.fetch(request);
    }
    return errorJson("Not found", 404, "NOT_FOUND");
  },
} satisfies ExportedHandler<Env>;
