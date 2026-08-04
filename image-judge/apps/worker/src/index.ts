/** image-judge-api Worker 入口：路由 + 标准错误兜底（文档 §9、§19）。
 *
 * 端点：
 *   GET  /desktop/authorize  桌面授权桥接入口（302 到 Zhang Auth）
 *   GET  /auth/callback      Zhang Auth 固定回调（静态登记）
 *   POST /desktop/token      code 换平台令牌（校验桌面侧 PKCE）
 *   POST /desktop/refresh    刷新平台令牌（轮换）
 *   POST /desktop/logout     注销（撤销会话）
 *   POST /api/v1/evaluate    模型代理（额度 + 并发 + 幂等）
 *   GET  /healthz            健康检查
 */
import type { Env } from "./types";
import { errorResponse, json, newId } from "./types";
import {
  handleAuthCallback,
  handleDesktopAuthorize,
  handleDesktopLogout,
  handleDesktopRefresh,
  handleDesktopToken,
} from "./auth";
import { handleEvaluate } from "./evaluate";

export { UserConcurrencyLock } from "./ratelimit";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const requestId = newId("srv");

    try {
      // ---- 桌面授权桥接（OIDC）----
      if (url.pathname === "/desktop/authorize" && method === "GET") {
        return await handleDesktopAuthorize(request, env);
      }
      if (url.pathname === "/auth/callback" && method === "GET") {
        return await handleAuthCallback(request, env);
      }
      if (url.pathname === "/desktop/token" && method === "POST") {
        return await handleDesktopToken(request, env);
      }
      if (url.pathname === "/desktop/refresh" && method === "POST") {
        return await handleDesktopRefresh(request, env);
      }
      if (url.pathname === "/desktop/logout" && method === "POST") {
        return await handleDesktopLogout(request, env);
      }

      // ---- 模型代理 ----
  if (url.pathname === "/api/v1/evaluate" && method === "POST") {
    if (!env.DASHSCOPE_API_KEY) {
      return errorResponse(503, "PLATFORM_MODEL_NOT_CONFIGURED", "平台模型尚未配置；当前请使用本地 BYOK 模式", false, requestId);
    }
    return await handleEvaluate(request, env);
      }

      // ---- 健康检查 ----
      if (url.pathname === "/healthz" && method === "GET") {
        return json({ ok: true, service: "image-judge-api" });
      }

      return errorResponse(404, "NOT_FOUND", `未知端点 ${method} ${url.pathname}`, false, requestId);
    } catch (err) {
      console.error("unhandled error:", err);
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "服务器内部错误",
        true,
        requestId
      );
    }
  },
};
