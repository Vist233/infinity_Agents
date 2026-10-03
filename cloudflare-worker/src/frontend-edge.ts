import type { Env } from "./env";
import { json } from "./http";
import { handleImageJudge } from "./image-judge";
import { handleLogin, handleCallback, handleLogout, validateBrowserMutation } from "./auth";

export { ImageJudgeUserConcurrencyLock } from "./image-judge";

function isImageJudgeApi(path: string): boolean {
  return path === "/image-judge/healthz"
    || path.startsWith("/image-judge/desktop/")
    || path.startsWith("/image-judge/auth/")
    || path.startsWith("/image-judge/api/");
}

function localRuntimeRequired(): Response {
  return json({
    error: "LOCAL_RUNTIME_REQUIRED",
    message: "Cloud task, paper and chat APIs are retired. Open the local application.",
    local_app_url: "http://localhost:3000/task-center/",
  }, 410, { "cache-control": "no-store" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return json({
        status: "ok", service: "infinity-agents-edge", mode: "frontend-imagejudge-compatibility",
        task_execution: "local", paper_processing: "local", scheduler: "disabled",
      });
    }
    if (isImageJudgeApi(path)) return handleImageJudge(request, env);
    // Keep existing browser authentication callbacks during migration; desktop
    // authentication uses its own ImageJudge namespace above.
    if (request.method === "GET" && path === "/auth/login") return handleLogin(request, env);
    if (request.method === "GET" && path === "/auth/callback") return handleCallback(request, env);
    if (request.method === "POST" && path === "/auth/logout") {
      return validateBrowserMutation(request, env) ?? handleLogout(request, env);
    }
    if (path === "/api" || path.startsWith("/api/")) return localRuntimeRequired();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "METHOD_NOT_ALLOWED" }, 405, { allow: "GET, HEAD" });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
