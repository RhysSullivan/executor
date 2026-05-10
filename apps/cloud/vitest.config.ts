import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(__dirname, "./test-stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.node.test.ts", "**/node_modules/**"],
    globalSetup: ["./scripts/test-globalsetup.ts"],
    fileParallelism: false,
    env: {
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
      EXECUTOR_DIRECT_DATABASE_URL: "true",
      WORKOS_API_KEY: "test_api_key",
      WORKOS_CLIENT_ID: "test_client_id",
      WORKOS_COOKIE_PASSWORD: "test_cookie_password_at_least_32_chars!",
      MCP_AUTHKIT_DOMAIN: "https://test-authkit.example.com",
      MCP_RESOURCE_ORIGIN: "https://test-resource.example.com",
      NODE_ENV: "test",
    },
    // postgres.js's Cloudflare polyfill leaves a couple of `.then()` chains
    // on `writer.ready` uncaught when the socket tears down before the
    // writer settles (DbService scope close). The rejection is benign —
    // the socket is closing anyway — so filter it out rather than fail
    // the run with noise.
    onUnhandledError(error) {
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: Vitest unhandled-error hook receives unknown host errors
      if (error && (error as Error).message === "Stream was cancelled.") {
        return false;
      }
    },
  },
});
