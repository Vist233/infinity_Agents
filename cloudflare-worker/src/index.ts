import type { Env } from "./env";
import { errorJson, json } from "./http";
import { handleLogin, handleCallback, handleLogout, resolveUser, validateBrowserMutation, type AuthedUser } from "./auth";
import {
  createSession,
  getSessions,
  getSessionMessages,
  updateSessionTitle,
  removeSession,
} from "./sessions";
import { handleCancelChatTaskConfirmation, handleChat } from "./chat";
import { currentDailyUsage } from "./quota";
import { handleImageJudge } from "./image-judge";
import { handleTaskApi } from "./tasks";
import { handleWorkerControlApi } from "./worker-control";
import { handleUserSettings } from "./settings";

export { ImageJudgeUserConcurrencyLock } from "./image-judge";

/**
 * Apply a Set-Cookie header produced by a token refresh to an existing
 * response without consuming or rebuilding its body.
 */
function withCookies(response: Response, setCookies?: string[]): Response {
  if (!setCookies?.length) return response;
  const headers = new Headers(response.headers);
  for (const setCookie of setCookies) headers.append("set-cookie", setCookie);
  return new Response(response.body, { status: response.status, headers });
}

function taskDetailShellPath(pathname: string): string | null {
  const match = pathname.match(/^\/(code-agent|task-center)\/tasks\/[^/]+\/?$/);
  return match ? `/${match[1]}/tasks/preview/` : null;
}

/** GET /api/me — current user and today's quota usage. */
async function handleMe(env: Env, user: AuthedUser): Promise<Response> {
  const usage = await currentDailyUsage(env, user.userId);
  return json({
    user: { id: user.userId, email: user.email, name: user.name ?? null },
    quota: { used: usage.count, limit: usage.limit },
  });
}

/**
 * Infinity Edge routes both products from one Worker:
 *
 * - `/image-judge/*` is the isolated ImageJudge API namespace.
 * - `/auth/*` and `/api/*` are the Analysis session/auth API.
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
    // with Analysis' callback.
    const isImageJudgeRoute =
      pathname === "/image-judge/healthz" ||
      pathname.startsWith("/image-judge/desktop/") ||
      pathname.startsWith("/image-judge/auth/") ||
      pathname.startsWith("/image-judge/api/");
    if (isImageJudgeRoute) {
      return handleImageJudge(request, env);
    }

    // Analysis authentication is cookie-backed and server-side. Tokens are
    // kept in the Infinity D1 session table; the browser only receives the
    // opaque `ia_session` cookie.
    if (method === "GET" && pathname === "/auth/login") {
      return handleLogin(request, env);
    }
    if (method === "GET" && pathname === "/auth/callback") {
      return handleCallback(request, env);
    }
    if (method === "POST" && pathname === "/auth/logout") {
      const csrfError = validateBrowserMutation(request, env);
      if (csrfError) return csrfError;
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
      const { user, setCookies } = resolved;

      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        const csrfError = validateBrowserMutation(request, env);
        if (csrfError) return withCookies(csrfError, setCookies);
      }

      if (method === "GET" && pathname === "/api/me") {
        return withCookies(await handleMe(env, user), setCookies);
      }

      if (method === "GET" && pathname === "/api/settings") {
        return withCookies(await handleUserSettings(request, env, user), setCookies);
      }

      const taskResponse = await handleTaskApi(request, env, user);
      if (taskResponse) return withCookies(taskResponse, setCookies);

      if (pathname === "/api/sessions") {
        if (method === "POST") return withCookies(await createSession(env, user), setCookies);
        if (method === "GET") return withCookies(await getSessions(env, user), setCookies);
        return withCookies(errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED"), setCookies);
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/messages|\/title)?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const sub = sessionMatch[2];
        if (sub === "/messages" && method === "GET") {
          return withCookies(await getSessionMessages(env, user, sessionId), setCookies);
        }
        if (sub === "/title" && method === "PATCH") {
          return withCookies(await updateSessionTitle(env, user, sessionId, request), setCookies);
        }
        if (!sub && method === "DELETE") {
          return withCookies(await removeSession(env, user, sessionId), setCookies);
        }
        return withCookies(errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED"), setCookies);
      }

      if (pathname === "/api/chat" && method === "POST") {
        return withCookies(await handleChat(request, env, user), setCookies);
      }
      if (pathname === "/api/chat/task-confirmation/cancel" && method === "POST") {
        return withCookies(await handleCancelChatTaskConfirmation(request, env, user), setCookies);
      }

      return withCookies(errorJson("Not found", 404, "NOT_FOUND"), setCookies);
    }

    if (method === "GET" || method === "HEAD") {
      // Next static export emits one deterministic dynamic-route shell. Keep
      // the browser URL (and therefore useParams()) intact while serving that
      // shell for every authenticated task ID.
      const shellPath = taskDetailShellPath(pathname);
      if (shellPath) {
        const shellUrl = new URL(request.url);
        shellUrl.pathname = shellPath;
        return env.ASSETS.fetch(new Request(shellUrl, request));
      }
      return env.ASSETS.fetch(request);
    }
    return errorJson("Not found", 404, "NOT_FOUND");
  },
} satisfies ExportedHandler<Env>;
