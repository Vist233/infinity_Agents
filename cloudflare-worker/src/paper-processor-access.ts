import type { Env } from "./env";

const PROCESSOR_PREFIX = "/api/paper-processor";

type ProcessorMethod = "GET" | "POST" | "PUT";

const ROUTES: ReadonlyArray<{ method: ProcessorMethod; path: string }> = [
  { method: "POST", path: `${PROCESSOR_PREFIX}/connect` },
  { method: "POST", path: `${PROCESSOR_PREFIX}/poll` },
  { method: "POST", path: `${PROCESSOR_PREFIX}/control` },
  { method: "PUT", path: `${PROCESSOR_PREFIX}/object` },
];

/**
 * Keep the application route contract identical to the Cloudflare exception:
 * only fixed Processor methods and paths are eligible for the BIC skip.
 * Attempt/resource/object identifiers are deliberately carried in validated
 * envelopes instead of URL paths.
 */
export function isPaperProcessorProtocolRoute(method: string, pathname: string): boolean {
  return ROUTES.some((route) => route.method === method && route.path === pathname);
}

/**
 * `CF-Connecting-IP` is supplied by Cloudflare at the custom-domain edge. The
 * Worker uses it only as a fail-closed second gate after the zone-level rule.
 */
export function isApprovedPaperProcessorRequest(request: Request, env: Env): boolean {
  const configuredSourceIp = env.PAPER_PROCESSOR_SOURCE_IP?.trim() ?? "";
  const connectingIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!configuredSourceIp || connectingIp !== configuredSourceIp) return false;
  return isPaperProcessorProtocolRoute(request.method, new URL(request.url).pathname);
}

export function isPaperProcessorNamespacePath(pathname: string): boolean {
  return pathname === `${PROCESSOR_PREFIX}/connect` || pathname.startsWith(`${PROCESSOR_PREFIX}/`);
}
