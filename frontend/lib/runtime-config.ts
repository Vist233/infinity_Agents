const DEFAULT_API_BASE = "http://localhost:8008";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export function getApiBase(): string {
  const envBase = process.env.NEXT_PUBLIC_API_BASE?.trim();
  if (envBase) {
    return trimTrailingSlash(envBase);
  }

  if (typeof window === "undefined") {
    return DEFAULT_API_BASE;
  }

  const { protocol, hostname } = window.location;
  if (protocol === "http:" || protocol === "https:") {
    return `${protocol}//${hostname}:8008`;
  }
  return DEFAULT_API_BASE;
}

export function getWsBase(apiBase = getApiBase()): string {
  return apiBase.replace(/^http/, "ws");
}
