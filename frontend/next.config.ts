import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  // The repository also has a root lockfile. Pinning the Turbopack root keeps
  // the static export deterministic and prevents Next from selecting it as the
  // application root.
  turbopack: { root: projectRoot },
};

export default nextConfig;
