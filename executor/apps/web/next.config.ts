import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const nextConfig: NextConfig = {
  turbopack: {
    root: workspaceRoot,
  },
  transpilePackages: ["@executor/contracts"],
};

export default nextConfig;
