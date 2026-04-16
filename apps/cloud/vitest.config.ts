import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.node.test.ts", "**/node_modules/**"],
    globalSetup: ["./scripts/test-globalsetup.ts"],
    // postgres.js's Cloudflare polyfill leaves a couple of `.then()` chains
    // on `writer.ready` uncaught when the socket tears down before the
    // writer settles (DbService scope close). The rejection is benign —
    // the socket is closing anyway — so filter it out rather than fail
    // the run with noise.
    onUnhandledError(error) {
      if (error && (error as Error).message === "Stream was cancelled.") {
        return false;
      }
    },
  },
});
