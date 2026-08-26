/// <reference types="@cloudflare/workers-types" />

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CHAT_RATE_LIMITER: RateLimitBinding;

  // ImageJudge uses separate D1/KV/DO bindings and never reads Analysis'
  // session tables or authentication secrets.
  IMAGE_JUDGE_DB: D1Database;
  IMAGE_JUDGE_KV: KVNamespace;
  IMAGE_JUDGE_USER_LOCK: DurableObjectNamespace;

  // Vars
  STEPFUN_BASE_URL: string;
  STEPFUN_MODEL: string;
  APP_BASE_URL: string;
  ZHANG_AUTH_BASE_URL: string;
  ZHANG_AUTH_JWKS_URL: string;
  ZHANG_AUTH_CLIENT_ID: string;
  ZHANG_AUTH_AUD: string;
  DAILY_QUOTA: string;
  IMAGE_JUDGE_ZHANG_AUTH_ISSUER: string;
  IMAGE_JUDGE_OIDC_CLIENT_ID: string;
  IMAGE_JUDGE_OIDC_REDIRECT_URI: string;
  IMAGE_JUDGE_DASHSCOPE_BASE_URL: string;
  IMAGE_JUDGE_MODEL_ID: string;
  IMAGE_JUDGE_DAILY_QUOTA: string;
  IMAGE_JUDGE_ACCESS_TOKEN_TTL_SECONDS: string;
  IMAGE_JUDGE_REFRESH_TOKEN_TTL_SECONDS: string;
  IMAGE_JUDGE_MAX_IMAGE_BYTES: string;

  // Cloudflare-native Analysis/Coding task inputs and enrollment controls.
  RESOURCE_BUCKET?: R2Bucket;
  TASK_UPLOAD_MAX_BYTES?: string;
  TASK_ARTIFACT_MAX_BYTES?: string;
  // D1 outbox delivery to the administrator-managed HTTPS Redis Relay.
  REDIS_RELAY_URL?: string;
  OUTBOX_RELAY_BATCH_SIZE?: string;
  // AES-GCM key used to keep a recoverable copy of persistent Worker
  // credentials encrypted at rest. The raw key is configured as a secret.
  WORKER_CREDENTIAL_ENCRYPTION_KEY?: string;
  // Separate AES-GCM key for OAuth access/refresh tokens stored in D1.
  AUTH_SESSION_ENCRYPTION_KEY: string;
  // Secrets
  STEPFUN_API_KEY: string;
  ZHANG_AUTH_CLIENT_SECRET: string;
  IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET?: string;
  IMAGE_JUDGE_TOKEN_SIGNING_SECRET?: string;
  IMAGE_JUDGE_DASHSCOPE_API_KEY?: string;
  REDIS_RELAY_PUBLISH_SECRET?: string;
  // Dedicated Paper Processor control-plane identity. This is never accepted
  // by the public Worker-v2 routes and is not a D1/R2/Redis parent credential.
  PAPER_PROCESSOR_ID?: string;
  PAPER_PROCESSOR_SHARED_SECRET?: string;
  // Explicit opt-in for the bounded Paper image-analysis provider egress.
  PAPER_IMAGE_ANALYSIS_EGRESS?: string;
}

export const SESSION_COOKIE = "ia_session";
export const CSRF_COOKIE = "infinity_csrf";
export const OAUTH_STATE_COOKIE = "ia_oauth_state";
export const AUTH_CALLBACK_PATH = "/auth/callback";
export const MAX_CONTEXT_MESSAGES = 20;
export const PAPER_CACHE_TTL_SECONDS = 3600;
