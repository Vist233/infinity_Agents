// Runtime API base. The frontend is served by the same Cloudflare Worker that
// exposes the API, so all requests are same-origin: we use relative URLs in the
// browser (empty base) and only fall back to an absolute base during SSR/build.
const DEFAULT_API_BASE = "";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export function getApiBase(): string {
  const envBase = process.env.NEXT_PUBLIC_API_BASE?.trim();
  if (envBase && typeof window === "undefined") {
    return trimTrailingSlash(envBase);
  }
  // Same-origin: relative paths like `/api/...` resolve against the current
  // document origin, so no host/port is needed.
  return DEFAULT_API_BASE;
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

/** Local shared runtime: no login flow. Redirect to task center. */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  window.location.assign("/task-center/");
}
