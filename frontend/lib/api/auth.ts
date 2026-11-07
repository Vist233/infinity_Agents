import { getApiBase, IS_STATIC_FRONTEND, withCsrfHeader } from "@/lib/runtime-config";

/** Keep authentication checks from leaving a page in an unbounded loading state. */
export const AUTH_REQUEST_TIMEOUT_MS = 10_000;

export class AuthRequestTimeoutError extends Error {
  constructor() {
    super("Authentication request timed out");
    this.name = "AuthRequestTimeoutError";
  }
}

export function isAuthRequestTimeoutError(error: unknown): error is AuthRequestTimeoutError {
  return error instanceof Error && error.name === "AuthRequestTimeoutError";
}

async function withAuthRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AUTH_REQUEST_TIMEOUT_MS);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw new AuthRequestTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchAuthResponse(input: string): Promise<{ response: Response; payload?: unknown }> {
  return withAuthRequestTimeout(async (signal) => {
    const response = await fetch(input, { credentials: "include", signal });
    // Keep the timeout active while consuming the response body as well as
    // while waiting for response headers.
    const payload = response.ok ? await response.json() : undefined;
    return { response, payload };
  });
}

export interface CurrentUser {
  id: string;
  email: string | null;
  name?: string | null;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  // The static cloud export has no account backend. Never send an /api/me or
  // /auth/me probe from the browser.
  if (IS_STATIC_FRONTEND) return null;
  const { response, payload } = await fetchAuthResponse(`${getApiBase()}/api/me`);
  if (response.status === 401) return null;
  if (response.status === 404) {
    // The local FastAPI compatibility server exposes the older /auth/me
    // shape; production Cloudflare uses /api/me. Keeping this fallback makes
    // local browser acceptance exercise the same authenticated footer.
    const legacyResult = await fetchAuthResponse(`${getApiBase()}/auth/me`);
    const legacy = legacyResult.response;
    if (legacy.status === 401) return null;
    if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
    const legacyPayload = legacyResult.payload as { user_id?: string; email?: string | null } | undefined;
    return legacyPayload?.user_id ? { id: legacyPayload.user_id, email: legacyPayload.email ?? null } : null;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (payload as { user?: CurrentUser } | undefined)?.user ?? null;
}

export async function logout(): Promise<void> {
  if (IS_STATIC_FRONTEND) return;
  const response = await fetch(`${getApiBase()}/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: withCsrfHeader(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
