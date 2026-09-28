import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const staticFrontend = process.env.CLOUDFLARE_EXPORT === "1" || process.env.NEXT_PUBLIC_STATIC_FRONTEND === "1";
const localRewrites = async () => {
  const backend = process.env.API_PROXY_TARGET || (
    process.env.NODE_ENV === "production" ? "" : "http://localhost:8008"
  );
  // A production deployment without an explicit backend is expected to use
  // same-origin routing from its reverse proxy. Never bake a Docker service
  // hostname into a bundle that may run outside Compose.
  if (!backend) return [];
  return [
    { source: "/api/:path*", destination: `${backend}/api/:path*` },
    { source: "/auth/:path*", destination: `${backend}/auth/:path*` },
  ];
};

const nextConfig: NextConfig = {
  // A static deployment contains only the browser shell. Business APIs must
  // be provided by the local runtime or an explicitly configured HTTPS API.
  output: staticFrontend ? "export" : undefined,
  env: {
    NEXT_PUBLIC_STATIC_FRONTEND: staticFrontend ? "1" : "0",
  },
  ...(staticFrontend ? {} : { rewrites: localRewrites }),
  experimental: {
    // Local Task Center uploads can exceed Next.js proxy's default 10MB body
    // buffer. Raise it so same-origin /api/* and /auth/* rewrites keep working
    // during local development when method docs or datasets are larger.
    // Keep the proxy ceiling above the API's 5 GiB dataset limit. The
    // backend still enforces the per-upload and archive safety limits.
    proxyClientMaxBodySize: "6gb",
  },
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: { root: projectRoot },
};

export default nextConfig;
