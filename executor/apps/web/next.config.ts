import type { NextConfig } from "next";

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
  transpilePackages: ["@executor/convex"],
  env: {
    // Map canonical env vars to NEXT_PUBLIC_ so they're available client-side.
    // This lets us keep a single root .env without NEXT_PUBLIC_ prefixes.
    NEXT_PUBLIC_CONVEX_URL: process.env.CONVEX_URL,
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
