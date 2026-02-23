import type { NextConfig } from "next";

function toSiteUrl(convexUrl?: string): string | undefined {
  if (!convexUrl) {
    return undefined;
  }
  if (convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site");
  }
  return convexUrl;
}

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // TS2589 ("type instantiation excessively deep") fires on convex-helpers
    // custom function builders when combined with our large DataModel schema.
    // Type checking is handled separately via `bun run typecheck`.
    ignoreBuildErrors: true,
  },
  transpilePackages: ["@executor/core", "@executor/database", "@executor/ui"],
  env: {
    NEXT_PUBLIC_CONVEX_URL: process.env.EXECUTOR_WEB_CONVEX_URL ?? process.env.CONVEX_URL,
    NEXT_PUBLIC_CONVEX_SITE_URL:
      process.env.EXECUTOR_WEB_CONVEX_SITE_URL
      ?? process.env.CONVEX_SITE_URL
      ?? toSiteUrl(process.env.EXECUTOR_WEB_CONVEX_URL ?? process.env.CONVEX_URL),
    NEXT_PUBLIC_WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID,
    NEXT_PUBLIC_STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID,
  },
  experimental: {
    turbopackFileSystemCacheForDev: true,
  },
  async redirects() {
    return [
      {
        source: "/install.sh",
        destination: "/install",
        permanent: false,
      },
      {
        source: "/tools/credentials",
        destination: "/tools/connections",
        permanent: false,
      },
      {
        source: "/tools/runner",
        destination: "/tools/editor",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
