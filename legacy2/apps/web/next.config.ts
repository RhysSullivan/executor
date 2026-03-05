import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appDir = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: resolve(appDir, "../.."),
  outputFileTracingIncludes: {
    "/*": [
      "../../packages/management-api/src/openapi-extractor-wasm/openapi_extractor_bg.wasm",
    ],
  },
};

export default nextConfig;
