import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: { root: projectRoot },
  // Local development only: the frontend is served from :3000 while the
  // FastAPI backend runs on :8000. Proxy same-origin /api/* to the backend so
  // the browser never faces a CORS boundary (SSE included). Production keeps
  // same-origin routing untouched (API is served by the host platform).
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    const backend = process.env.API_PROXY_TARGET || "http://localhost:8000";
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
      { source: "/auth/:path*", destination: `${backend}/auth/:path*` },
    ];
  },
};

export default nextConfig;
