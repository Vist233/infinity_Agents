const PREFIX = "/api/discovery-processor";
const ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: `${PREFIX}/connect` },
  { method: "POST", path: `${PREFIX}/poll` },
  { method: "POST", path: `${PREFIX}/control` },
];

/**
 * Discovery is a private backend that initiates outbound HTTPS calls to the
 * Edge. Its identity, bootstrap secret, short-lived session, and fenced lease
 * capabilities authenticate the protocol; the backend has no stable public
 * egress IP to allowlist here.
 */
export function isApprovedDiscoveryProcessorRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return ROUTES.some((route) => route.method === request.method && route.path === pathname);
}

export function isDiscoveryProcessorNamespacePath(pathname: string): boolean {
  return pathname === `${PREFIX}/connect` || pathname.startsWith(`${PREFIX}/`);
}
