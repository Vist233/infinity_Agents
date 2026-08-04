/** 模型代理端点 POST /api/v1/evaluate（文档 §9.2、§9.4、§19.2）。
 *
 * 流程：Bearer 校验 → multipart 解析 → 图片校验 → KV 幂等 →
 * 每日额度 → 并发 lease → 扣额度 → 调百炼（失败重试 1 次，不额外扣额度）→
 * 缓存结果 → 释放 lease → 返回。
 */
import type { Env } from "./types";
import { errorResponse, json, newId, secondsUntilNextUtcDay } from "./types";
import { verifyToken } from "./tokens";
import { acquireLease, checkQuota, incrementQuota, releaseLease } from "./ratelimit";

const IDEMPOTENCY_TTL = 86_400; // 幂等结果缓存 1 天（与额度日对齐）
const LEASE_TTL_MS = 180_000; // 单次调用 lease 3 分钟
const MODEL_TIMEOUT_MS = 120_000;

// Keep the platform response contract identical to the desktop BYOK gateway.
// The model is still validated again by the desktop Pydantic schema.
const EVALUATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "task_type",
    "predicted_category",
    "status",
    "spotting_features",
    "candidate_categories",
    "image_quality",
    "reasoning_summary",
    "review",
  ],
  properties: {
    schema_version: { type: "string", enum: ["2.0"] },
    task_type: { type: "string", enum: ["CLASSIFICATION"] },
    predicted_category: { type: "string", minLength: 1, maxLength: 100 },
    status: { type: "string", enum: ["CLASSIFIED", "UNKNOWN", "REVIEW"] },
    spotting_features: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["feature_id", "state", "evidence", "supports", "contradicts"],
        properties: {
          feature_id: { type: "string", minLength: 1, maxLength: 100 },
          state: { type: "string", enum: ["PRESENT", "ABSENT", "UNCLEAR"] },
          evidence: { type: "string", maxLength: 500 },
          supports: { type: "array", maxItems: 20, items: { type: "string" } },
          contradicts: { type: "array", maxItems: 20, items: { type: "string" } },
        },
      },
    },
    candidate_categories: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category_id", "rank", "match_strength", "evidence"],
        properties: {
          category_id: { type: "string", minLength: 1, maxLength: 100 },
          rank: { type: "integer", minimum: 1, maximum: 20 },
          match_strength: { type: "string", enum: ["STRONG", "MODERATE", "WEAK"] },
          evidence: { type: "array", maxItems: 10, items: { type: "string" } },
        },
      },
    },
    image_quality: {
      type: "object",
      additionalProperties: false,
      required: ["reference", "target"],
      properties: {
        reference: { type: "string", enum: ["GOOD", "LIMITED", "UNUSABLE"] },
        target: { type: "string", enum: ["GOOD", "LIMITED", "UNUSABLE"] },
      },
    },
    reasoning_summary: { type: "string", maxLength: 500 },
    review: {
      type: "object",
      additionalProperties: false,
      required: ["required", "reasons"],
      properties: {
        required: { type: "boolean" },
        reasons: { type: "array", maxItems: 20, items: { type: "string" } },
      },
    },
  },
} as const;

interface EvaluateFormData {
  clientRequestId: string;
  model: string;
  promptVersion: string;
  taskRules: string;
  outputSchemaVersion: string;
  referenceImage: { dataUrl: string; bytes: number };
  targetImage: { dataUrl: string; bytes: number };
}

/** 解析并校验 multipart 请求。返回 null 表示校验失败（调用方已收到错误响应）。 */
async function parseEvaluateRequest(
  request: Request,
  env: Env
): Promise<{ data?: EvaluateFormData; error?: Response }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return {
    error: errorResponse(400, "INVALID_REQUEST", "Unable to parse the multipart request body", false),
    };
  }

  const clientRequestId = String(form.get("client_request_id") || "");
  const model = String(form.get("model") || "");
  const promptVersion = String(form.get("prompt_version") || "");
  const taskRules = String(form.get("task_rules") || "");
  const outputSchemaVersion = String(form.get("output_schema_version") || "");

  if (!clientRequestId || clientRequestId.length > 128) {
    return {
      error: errorResponse(400, "INVALID_REQUEST", "client_request_id is missing or invalid", false),
    };
  }
  if (model !== env.MODEL_ID) {
    return {
      error: errorResponse(
        400,
        "INVALID_REQUEST",
        `Only model ${env.MODEL_ID} is supported`,
        false
      ),
    };
  }
  if (!taskRules.trim()) {
    return {
      error: errorResponse(400, "INVALID_REQUEST", "task_rules must not be empty", false),
    };
  }
  if (promptVersion !== "2.0" || outputSchemaVersion !== "2.0") {
    return {
      error: errorResponse(
        400,
        "UNSUPPORTED_SCHEMA",
        "Only ImageJudge 2.0 classification output is supported",
        false,
      ),
    };
  }

  const maxBytes = parseInt(env.MAX_IMAGE_BYTES || "10485760", 10);
  const referenceImage = await readImageFile(form.get("reference_image"), maxBytes);
  if (!referenceImage) {
    return {
      error: errorResponse(400, "IMAGE_INVALID", "reference_image is missing, too large, or unsupported", false),
    };
  }
  const targetImage = await readImageFile(form.get("target_image"), maxBytes);
  if (!targetImage) {
    return {
      error: errorResponse(400, "IMAGE_INVALID", "target_image is missing, too large, or unsupported", false),
    };
  }

  return {
    data: {
      clientRequestId,
      model,
      promptVersion,
      taskRules,
      outputSchemaVersion,
      referenceImage,
      targetImage,
    },
  };
}

/** 读取图片字段：校验大小与 magic bytes（JPEG/PNG/WebP），转为 data URL。 */
async function readImageFile(
  value: string | File | null,
  maxBytes: number
): Promise<{ dataUrl: string; bytes: number } | null> {
  if (!value || typeof value === "string") return null;
  const file = value;
  if (file.size <= 0 || file.size > maxBytes) return null;
  const buffer = new Uint8Array(await file.arrayBuffer());
  const mime = detectImageMime(buffer);
  if (!mime) return null;
  const dataUrl = `data:${mime};base64,${base64Encode(buffer)}`;
  return { dataUrl, bytes: file.size };
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface DashScopeChatResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** 调百炼 OpenAI 兼容接口：两图 data URL，image[0]=参考图、image[1]=目标图（顺序严格固定）。 */
async function callDashScope(
  env: Env,
  data: EvaluateFormData
): Promise<{ text: string; requestId: string; usage: Record<string, number> }> {
  const body = {
    model: data.model,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "evaluation_result",
        schema: EVALUATION_JSON_SCHEMA,
      },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: data.referenceImage.dataUrl } },
          { type: "image_url", image_url: { url: data.targetImage.dataUrl } },
          { type: "text", text: data.taskRules },
        ],
      },
    ],
  };
  const url = `${env.DASHSCOPE_BASE_URL}/chat/completions`;

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (resp.status === 429) {
        // 上游限流：透传 Retry-After，可重试（属同一逻辑请求，不额外扣额度）
        const retryAfter = resp.headers.get("Retry-After") || "10";
        throw new RateLimitedError(parseFloat(retryAfter) || 10);
      }
      if (resp.status >= 500) {
        lastError = `Upstream model service error: ${resp.status}`;
        continue; // 5xx 重试一次
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new ModelError(`Upstream model request failed: ${resp.status}`);
      }
      const parsed = (await resp.json()) as DashScopeChatResponse;
      const text = parsed.choices?.[0]?.message?.content;
      if (!text) {
        lastError = "The model returned an empty response";
        continue; // 视为可重试一次
      }
      const usage: Record<string, number> = {};
      if (parsed.usage) {
        usage.prompt_tokens = parsed.usage.prompt_tokens ?? 0;
        usage.completion_tokens = parsed.usage.completion_tokens ?? 0;
        usage.total_tokens = parsed.usage.total_tokens ?? 0;
      }
      return { text, requestId: parsed.id ?? "", usage };
    } catch (err) {
      if (err instanceof RateLimitedError || err instanceof ModelError) throw err;
      if ((err as Error).name === "AbortError") {
        lastError = "The model request timed out";
        continue;
      }
      lastError = `Upstream model request failed: ${(err as Error).message}`;
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ModelError(lastError || "The model request failed");
}

class RateLimitedError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super("The upstream model service is rate limited");
    this.retryAfter = retryAfter;
  }
}

class ModelError extends Error {}

export async function handleEvaluate(request: Request, env: Env): Promise<Response> {
  const serverRequestId = newId("srv");

  // 1. Bearer 校验
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = token ? await verifyToken(token, env.TOKEN_SIGNING_SECRET) : null;
  if (!payload || payload.type !== "access") {
    return errorResponse(401, "AUTH_EXPIRED", "The access token is invalid or expired", false, serverRequestId, {
      "WWW-Authenticate": "Bearer",
    });
  }
  const userSub = payload.sub;

  // 2. 解析请求
  const parsed = await parseEvaluateRequest(request, env);
  if (!parsed.data) return parsed.error!;
  const data = parsed.data;

  // 3. 幂等：相同 (user, client_request_id) 直接返回缓存结果
  const idemKey = `idem:${userSub}:${data.clientRequestId}`;
  const cached = await env.KV.get(idemKey, "json");
  if (cached) {
    return json(cached, 200, { "X-Idempotent-Replay": "true" });
  }

  // 4. 每日额度（超限快速失败）
  const quota = await checkQuota(env, userSub);
  const rateHeaders: Record<string, string> = {
    "X-RateLimit-Limit": String(quota.limit),
    "X-RateLimit-Remaining": String(quota.remaining),
  };
  if (!quota.allowed) {
    return errorResponse(
      429,
      "QUOTA_EXCEEDED",
      `Daily quota exhausted (${quota.limit} requests; resets at the next UTC day)`,
      false,
      serverRequestId,
      { ...rateHeaders, "Retry-After": String(quota.resetSeconds) }
    );
  }

  // 5. 每用户并发 1：lease
  const lease = await acquireLease(env, userSub, LEASE_TTL_MS);
  if (!lease.ok) {
    return errorResponse(
      429,
      "CONCURRENCY_LIMIT",
      "A request is already running for this account; wait for it to finish and try again",
      true,
      serverRequestId,
      { ...rateHeaders, "Retry-After": String(lease.retryAfter) }
    );
  }

  try {
    // 6. 原子扣额度（防止并发超卖；失败返回 429）
    const accepted = await incrementQuota(env, userSub);
    if (!accepted) {
      return errorResponse(
        429,
        "QUOTA_EXCEEDED",
        `Daily quota exhausted (${quota.limit} requests; resets at the next UTC day)`,
        false,
        serverRequestId,
        { ...rateHeaders, "Retry-After": String(secondsUntilNextUtcDay()) }
      );
    }

    // 7. 调百炼（内部失败重试 1 次，属同一逻辑请求不额外扣额度）
    const modelResult = await callDashScope(env, data);

    // 8. 幂等缓存
    const responseBody = {
      server_request_id: serverRequestId,
      client_request_id: data.clientRequestId,
      model: data.model,
      result: modelResult.text,
      usage: modelResult.usage,
      request_id: modelResult.requestId,
    };
    await env.KV.put(idemKey, JSON.stringify(responseBody), {
      expirationTtl: IDEMPOTENCY_TTL,
    });

    return json(responseBody, 200, {
      ...rateHeaders,
      "X-RateLimit-Remaining": String(Math.max(0, quota.remaining - 1)),
    });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "The model service is rate limited; try again later",
        true,
        serverRequestId,
        { ...rateHeaders, "Retry-After": String(Math.ceil(err.retryAfter)) }
      );
    }
    const message = err instanceof Error ? err.message : "The model request failed";
    return errorResponse(502, "MODEL_ERROR", message, true, serverRequestId, rateHeaders);
  } finally {
    await releaseLease(env, userSub);
  }
}
