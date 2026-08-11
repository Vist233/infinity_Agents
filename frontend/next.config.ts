import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // output: "export" removed: incompatible with dynamic routes without
  // generateStaticParams() and breaks SSE streaming. Standard server mode
  // supports both runtime routing and SSE.
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
  // Local development and the isolated acceptance stack: the frontend is
  // served separately from FastAPI, so proxy both API and auth routes to keep
  // cookies, CSRF, SSE, and the local login flow same-origin. In production,
  // an unset API_PROXY_TARGET means the API is already same-origin (for
  // example, a Cloudflare Worker route), so leave these paths untouched
  // instead of guessing a Docker-only hostname.
  async rewrites() {
    const backend = process.env.API_PROXY_TARGET || (
      process.env.NODE_ENV === "production" ? "" : "http://localhost:8000"
    );
    // A production deployment without an explicit backend is expected to use
    // same-origin routing from its reverse proxy. Never bake a Docker service
    // hostname into a bundle that may run outside Compose.
    if (!backend) return [];
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
      { source: "/auth/:path*", destination: `${backend}/auth/:path*` },
    ];
  },
};

export default nextConfig;
