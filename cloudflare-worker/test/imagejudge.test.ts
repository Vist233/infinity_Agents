import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fake-d1";

function imageJudgeEnv() {
  const { env } = makeEnv();
  Object.assign(env, {
    IMAGE_JUDGE_DB: env.DB,
    IMAGE_JUDGE_KV: {} as KVNamespace,
    IMAGE_JUDGE_USER_LOCK: {} as DurableObjectNamespace,
    IMAGE_JUDGE_ZHANG_AUTH_ISSUER: "https://auth.zhangyvjing.com",
    IMAGE_JUDGE_OIDC_CLIENT_ID: "image-judge-desktop",
    IMAGE_JUDGE_OIDC_REDIRECT_URI: "https://infinity.zhangyvjing.com/image-judge/auth/callback",
    IMAGE_JUDGE_DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    IMAGE_JUDGE_MODEL_ID: "qwen3-vl-235b-a22b-instruct",
    IMAGE_JUDGE_DAILY_QUOTA: "30",
    IMAGE_JUDGE_ACCESS_TOKEN_TTL_SECONDS: "900",
    IMAGE_JUDGE_REFRESH_TOKEN_TTL_SECONDS: "2592000",
    IMAGE_JUDGE_MAX_IMAGE_BYTES: "10485760",
    IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET: "client-secret",
    IMAGE_JUDGE_TOKEN_SIGNING_SECRET: "token-secret",
  });
  return env;
}

describe("ImageJudge namespace routing", () => {
  it("serves an isolated health endpoint without touching the chat API", async () => {
    const env = imageJudgeEnv();
    const response = await worker.fetch(new Request("https://infinity.zhangyvjing.com/image-judge/healthz"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "image-judge",
      platform_model_configured: false,
    });
  });

  it("keeps the existing Infinity health endpoint unchanged", async () => {
    const response = await worker.fetch(
      new Request("https://infinity.zhangyvjing.com/health"),
      imageJudgeEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "infinity-agents-edge" });
  });

  it("returns a non-retryable configuration error when the platform model key is absent", async () => {
    const response = await worker.fetch(
      new Request("https://infinity.zhangyvjing.com/image-judge/api/v1/evaluate", { method: "POST" }),
      imageJudgeEnv(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: "IMAGE_JUDGE_NOT_CONFIGURED",
        retryable: false,
      },
    });
  });
});
