/**
 * ImageJudge 在 Infinity Edge 中的命名空间路由。
 *
 * 这里把 ImageJudge 的绑定和密钥映射到独立命名空间，避免复用 Infinity
 * 聊天会话、StepFun 密钥或浏览器 session cookie。所有桌面端请求都必须
 * 使用 /image-judge 前缀。
 */
import type { Env as ImageJudgeEnv } from "./image-judge/types";
import { errorResponse, json, newId } from "./image-judge/types";
import {
  handleAuthCallback,
  handleDesktopAuthorize,
  handleDesktopLogout,
  handleDesktopRefresh,
  handleDesktopToken,
} from "./image-judge/auth";
import { handleEvaluate } from "./image-judge/evaluate";
import { UserConcurrencyLock } from "./image-judge/ratelimit";

export class ImageJudgeUserConcurrencyLock extends UserConcurrencyLock {}

type ImageJudgeBindings = {
  IMAGE_JUDGE_DB: D1Database;
  IMAGE_JUDGE_KV: KVNamespace;
  IMAGE_JUDGE_USER_LOCK: DurableObjectNamespace;
  IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET?: string;
  IMAGE_JUDGE_TOKEN_SIGNING_SECRET?: string;
  IMAGE_JUDGE_DASHSCOPE_API_KEY?: string;
  IMAGE_JUDGE_ZHANG_AUTH_ISSUER?: string;
  IMAGE_JUDGE_OIDC_CLIENT_ID?: string;
  IMAGE_JUDGE_OIDC_REDIRECT_URI?: string;
  IMAGE_JUDGE_DASHSCOPE_BASE_URL?: string;
  IMAGE_JUDGE_MODEL_ID?: string;
  IMAGE_JUDGE_DAILY_QUOTA?: string;
  IMAGE_JUDGE_ACCESS_TOKEN_TTL_SECONDS?: string;
  IMAGE_JUDGE_REFRESH_TOKEN_TTL_SECONDS?: string;
  IMAGE_JUDGE_MAX_IMAGE_BYTES?: string;
};

function imageJudgeEnv(env: ImageJudgeBindings): ImageJudgeEnv {
  return {
    DB: env.IMAGE_JUDGE_DB,
    KV: env.IMAGE_JUDGE_KV,
    USER_LOCK: env.IMAGE_JUDGE_USER_LOCK,
    DASHSCOPE_API_KEY: env.IMAGE_JUDGE_DASHSCOPE_API_KEY,
    ZHANG_AUTH_CLIENT_SECRET: env.IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET ?? "",
    TOKEN_SIGNING_SECRET: env.IMAGE_JUDGE_TOKEN_SIGNING_SECRET ?? "",
    ZHANG_AUTH_ISSUER: env.IMAGE_JUDGE_ZHANG_AUTH_ISSUER ?? "https://auth.zhangyvjing.com",
    OIDC_CLIENT_ID: env.IMAGE_JUDGE_OIDC_CLIENT_ID ?? "image-judge-desktop",
    OIDC_REDIRECT_URI:
      env.IMAGE_JUDGE_OIDC_REDIRECT_URI ??
      "https://infinity.zhangyvjing.com/image-judge/auth/callback",
    DASHSCOPE_BASE_URL:
      env.IMAGE_JUDGE_DASHSCOPE_BASE_URL ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    MODEL_ID: env.IMAGE_JUDGE_MODEL_ID ?? "qwen3-vl-235b-a22b-instruct",
    DAILY_QUOTA: env.IMAGE_JUDGE_DAILY_QUOTA ?? "30",
    ACCESS_TOKEN_TTL_SECONDS: env.IMAGE_JUDGE_ACCESS_TOKEN_TTL_SECONDS ?? "900",
    REFRESH_TOKEN_TTL_SECONDS: env.IMAGE_JUDGE_REFRESH_TOKEN_TTL_SECONDS ?? "2592000",
    MAX_IMAGE_BYTES: env.IMAGE_JUDGE_MAX_IMAGE_BYTES ?? "10485760",
  };
}

/** 处理 /image-judge/* 下的全部桌面授权、模型代理和健康检查端点。 */
export async function handleImageJudge(request: Request, env: ImageJudgeBindings): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith("/image-judge")
    ? url.pathname.slice("/image-judge".length) || "/"
    : url.pathname;
  const requestId = newId("srv");
  const imageEnv = imageJudgeEnv(env);

  const authPath =
    path === "/desktop/authorize" ||
    path === "/auth/callback" ||
    path === "/desktop/token" ||
    path === "/desktop/refresh" ||
    path === "/desktop/logout";
  if (authPath && (!env.IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET || !env.IMAGE_JUDGE_TOKEN_SIGNING_SECRET)) {
    return errorResponse(
      503,
      "IMAGE_JUDGE_AUTH_NOT_CONFIGURED",
      "ImageJudge authorization secrets are not configured",
      false,
      requestId,
    );
  }

  if (path === "/desktop/authorize" && request.method === "GET") {
    return handleDesktopAuthorize(request, imageEnv);
  }
  if (path === "/auth/callback" && request.method === "GET") {
    return handleAuthCallback(request, imageEnv);
  }
  if (path === "/desktop/token" && request.method === "POST") {
    return handleDesktopToken(request, imageEnv);
  }
  if (path === "/desktop/refresh" && request.method === "POST") {
    return handleDesktopRefresh(request, imageEnv);
  }
  if (path === "/desktop/logout" && request.method === "POST") {
    return handleDesktopLogout(request, imageEnv);
  }
  if (path === "/api/v1/evaluate" && request.method === "POST") {
    if (!env.IMAGE_JUDGE_DASHSCOPE_API_KEY) {
      return errorResponse(
        503,
        "PLATFORM_MODEL_NOT_CONFIGURED",
        "The platform model is not configured. Configure IMAGE_JUDGE_DASHSCOPE_API_KEY or use local BYOK mode",
        false,
        requestId,
      );
    }
    return handleEvaluate(request, imageEnv);
  }
  if (path === "/healthz" && request.method === "GET") {
    return json({ ok: true, service: "infinity-agents-edge", component: "image-judge" });
  }
  return errorResponse(404, "NOT_FOUND", `Unknown endpoint ${request.method} ${path}`, false, requestId);
}
