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
