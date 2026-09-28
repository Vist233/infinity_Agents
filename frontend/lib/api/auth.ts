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

export const AUTH_REQUEST_TIMEOUT_MS = 10_000;
export class AuthRequestTimeoutError extends Error {
  constructor() {
    super("Authentication request timed out");
    this.name = "AuthRequestTimeoutError";
  }
}
export function isAuthRequestTimeoutError(error: unknown): error is AuthRequestTimeoutError {
  return error instanceof AuthRequestTimeoutError;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return SHARED_USER;
}

export async function logout(): Promise<void> {
  // no-op on the local shared runtime
}
