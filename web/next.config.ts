import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const turbopackRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@aws-sdk/client-s3", "@aws-sdk/*"],
  // Without this, Next/Turbopack can "infer" the monorepo root as the parent
  // directory (due to multiple lockfiles), which breaks module resolution
  // (e.g. it tries to resolve `tailwindcss` from the repo root).
  turbopack: { root: turbopackRoot },
};

export default nextConfig;
