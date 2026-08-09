import { getApiBase, withCsrfHeader } from "@/lib/runtime-config";

export interface CurrentUser {
  id: string;
  email: string | null;
  name?: string | null;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const response = await fetch(`${getApiBase()}/api/me`, { credentials: "include" });
  if (response.status === 401) return null;
  if (response.status === 404) {
    // The local FastAPI compatibility server exposes the older /auth/me
    // shape; production Cloudflare uses /api/me. Keeping this fallback makes
    // local browser acceptance exercise the same authenticated footer.
    const legacy = await fetch(`${getApiBase()}/auth/me`, { credentials: "include" });
    if (legacy.status === 401) return null;
    if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
    const payload = await legacy.json() as { user_id?: string; email?: string | null };
    return payload.user_id ? { id: payload.user_id, email: payload.email ?? null } : null;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { user?: CurrentUser };
  return payload.user ?? null;
}

export async function logout(): Promise<void> {
  const response = await fetch(`${getApiBase()}/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: withCsrfHeader(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
