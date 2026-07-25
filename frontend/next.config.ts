import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Static export: the frontend is built to `out/` and served as Cloudflare
// Worker Static Assets. All API/auth/SSE routes are handled by the Worker on
// the same origin, so no rewrites/proxy are configured here.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  // Pin the workspace root so the outer monorepo lockfile doesn't confuse
  // Turbopack's root inference.
  turbopack: { root: projectRoot },
};

export default nextConfig;
