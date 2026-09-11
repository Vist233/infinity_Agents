import type { Env } from "./env";

const PREFIX = "/api/discovery-processor";
const ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: `${PREFIX}/connect` },
  { method: "POST", path: `${PREFIX}/poll` },
  { method: "POST", path: `${PREFIX}/control` },
];

/** The Discovery service has its own fixed egress and never uses Worker-v2 credentials. */
export function isApprovedDiscoveryProcessorRequest(request: Request, env: Env): boolean {
  const configuredSourceIp = env.DISCOVERY_PROCESSOR_SOURCE_IP?.trim() ?? "";
  const connectingIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!configuredSourceIp || connectingIp !== configuredSourceIp) return false;
  const pathname = new URL(request.url).pathname;
  return ROUTES.some((route) => route.method === request.method && route.path === pathname);
}

export function isDiscoveryProcessorNamespacePath(pathname: string): boolean {
  return pathname === `${PREFIX}/connect` || pathname.startsWith(`${PREFIX}/`);
}
