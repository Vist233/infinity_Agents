// Local shared-user authentication.
// On the pure-local main branch every request is treated as the same shared
// user.  There is no login flow, no session cookie, and no OIDC dance.
export interface CurrentUser {
  id: string;
  email: string | null;
  name?: string | null;
}

const SHARED_USER: CurrentUser = {
  id: "local-admin",
  email: null,
  name: "Local Admin",
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return SHARED_USER;
}

export async function logout(): Promise<void> {
  // no-op on the local shared runtime
}
