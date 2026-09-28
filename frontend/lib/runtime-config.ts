// Runtime API base. Local development uses relative URLs and Next rewrites;
// static deployments may opt into an explicit public HTTPS API origin. A
// static build without that origin must not pretend that its own asset host is
// the local task/paper backend.
const DEFAULT_API_BASE = "";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export function getApiBase(): string {
  const envBase = process.env.NEXT_PUBLIC_API_BASE?.trim();
  if (envBase) {
    return trimTrailingSlash(envBase);
  }
  // Relative paths like `/api/...` resolve against the current document origin.
  return DEFAULT_API_BASE;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether browser API calls have a declared runtime behind them.
 *
 * The static cloud build has no API by itself. In local development the
 * Next.js rewrites keep the browser same-origin with the local FastAPI
 * process, so an empty base is valid there. An HTTP API base is accepted only
 * for non-static local development; it must not be embedded behind HTTPS.
 */
export function canUseBrowserApi(): boolean {
  const apiBase = getApiBase();
  const staticDeployment = process.env.NEXT_PUBLIC_STATIC_FRONTEND === "1";
  if (!apiBase) return !staticDeployment;
  if (staticDeployment && !isHttpsUrl(apiBase)) return false;
  if (typeof window !== "undefined" && window.location.protocol === "https:" && !isHttpsUrl(apiBase)) return false;
  return true;
}

/** Return the readable nonce paired with the HttpOnly session cookie. */
export function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|; )infinity_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function withCsrfHeader(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  const token = getCsrfToken();
  if (token) result.set("X-CSRF-Token", token);
  return result;
}

/** Redirect the browser to the login flow, preserving the current location. */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const returnTo = window.location.pathname + window.location.search;
  window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
}
