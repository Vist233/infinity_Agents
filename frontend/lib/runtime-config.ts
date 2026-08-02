// Runtime API base. The frontend is served by the same Cloudflare Worker that
// exposes the API, so all requests are same-origin: we use relative URLs in the
// browser (empty base) and only fall back to an absolute base during SSR/build.
const DEFAULT_API_BASE = "";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export function getApiBase(): string {
  const envBase = process.env.NEXT_PUBLIC_API_BASE?.trim();
  if (envBase) {
    return trimTrailingSlash(envBase);
  }
  // Same-origin: relative paths like `/api/...` resolve against the current
  // document origin, so no host/port is needed.
  return DEFAULT_API_BASE;
}

/** Redirect the browser to the login flow, preserving the current location. */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const returnTo = window.location.pathname + window.location.search;
  window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
}
