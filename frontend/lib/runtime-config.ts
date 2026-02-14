const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export function getApiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_BASE?.trim();
  if (fromEnv) {
    return trimTrailingSlash(fromEnv);
  }

  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8008`;
  }

  return "http://localhost:8008";
}
