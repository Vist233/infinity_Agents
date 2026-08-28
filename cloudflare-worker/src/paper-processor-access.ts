import type { Env } from "./env";

const PROCESSOR_PREFIX = "/api/paper-processor";

type ProcessorMethod = "GET" | "POST" | "PUT";

const ROUTES: ReadonlyArray<{ method: ProcessorMethod; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/api\/paper-processor\/(connect|poll)$/ },
  { method: "GET", pattern: /^\/api\/paper-processor\/attempts\/[^/]+\/input(?:\/object)?$/ },
  { method: "POST", pattern: /^\/api\/paper-processor\/attempts\/[^/]+\/(renew|stage|finalize|cancel|fail)$/ },
  { method: "PUT", pattern: /^\/api\/paper-processor\/attempts\/[^/]+\/objects\/(source_pdf|text_pages|text_manifest|image|image_manifest)$/ },
];

/**
 * Keep the application route contract identical to the Cloudflare exception:
 * only the fixed Processor methods and path families are eligible for the
 * BIC skip. Dynamic attempt/resource values remain validated by the handler.
 */
export function isPaperProcessorProtocolRoute(method: string, pathname: string): boolean {
  return ROUTES.some((route) => route.method === method && route.pattern.test(pathname));
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
