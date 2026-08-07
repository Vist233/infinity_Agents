import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // output: "export" removed: incompatible with dynamic routes without
  // generateStaticParams() and breaks SSE streaming. Standard server mode
  // supports both runtime routing and SSE.
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: { root: projectRoot },
};

export default nextConfig;
