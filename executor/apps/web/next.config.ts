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

const appShellRewriteExclusions = [
  "api(?:/|$)",
  "_next(?:/|$)",
  "favicon\\.ico$",
  "sign-in(?:/|$)",
  "sign-up(?:/|$)",
  "sign-out(?:/|$)",
  "callback(?:/|$)",
  "install(?:/|$)",
  "install\\.sh(?:/|$)",
  "static-app-shell(?:/|$)",
  ".*\\..*",
].join("|");

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@executor/core", "@executor/database", "@executor/ui"],
  env: {
    // Map canonical env vars to NEXT_PUBLIC_ so they're available client-side.
    // This lets us keep a single root .env without NEXT_PUBLIC_ prefixes.
    NEXT_PUBLIC_CONVEX_URL: process.env.EXECUTOR_WEB_CONVEX_URL ?? process.env.CONVEX_URL,
    NEXT_PUBLIC_CONVEX_SITE_URL:
      process.env.EXECUTOR_WEB_CONVEX_SITE_URL
      ?? process.env.CONVEX_SITE_URL
      ?? toSiteUrl(process.env.EXECUTOR_WEB_CONVEX_URL ?? process.env.CONVEX_URL),
    NEXT_PUBLIC_WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID,
    NEXT_PUBLIC_STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID,
  },
  async rewrites() {
    return [
      {
        source: `/((?!${appShellRewriteExclusions}).*)`,
        destination: "/static-app-shell",
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/install.sh",
        destination: "/install",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
