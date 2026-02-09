import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  transpilePackages: ["@executor/contracts"],
  env: {
    // Map canonical env vars to NEXT_PUBLIC_ so they're available client-side.
    // This lets us keep a single root .env without NEXT_PUBLIC_ prefixes.
    NEXT_PUBLIC_CONVEX_URL: process.env.CONVEX_URL,
    NEXT_PUBLIC_WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID,
    NEXT_PUBLIC_STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID,
  },
};

export default nextConfig;
