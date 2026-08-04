/// <reference types="@cloudflare/workers-types" />

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CHAT_RATE_LIMITER: RateLimitBinding;

  // Vars
  STEPFUN_BASE_URL: string;
  STEPFUN_MODEL: string;
  APP_BASE_URL: string;
  ZHANG_AUTH_BASE_URL: string;
  ZHANG_AUTH_JWKS_URL: string;
  ZHANG_AUTH_CLIENT_ID: string;
  ZHANG_AUTH_AUD: string;
  DAILY_QUOTA: string;

  // Secrets
  STEPFUN_API_KEY: string;
  ZHANG_AUTH_CLIENT_SECRET: string;
}

export const SESSION_COOKIE = "ia_session";
export const OAUTH_STATE_COOKIE = "ia_oauth_state";
export const AUTH_CALLBACK_PATH = "/auth/callback";
export const MAX_CONTEXT_MESSAGES = 20;
export const PAPER_CACHE_TTL_SECONDS = 3600;
