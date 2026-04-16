// Vitest config for node-pool integration tests. These run close to
// production (real postgres, real DbService, real plugins, HttpApiClient
// through an in-process handler) but outside workerd. The workerd/
// miniflare path for the rest of the suite lives in vitest.config.ts.

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(__dirname, "./test-stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    include: ["src/**/*.node.test.ts"],
    globalSetup: ["./scripts/test-globalsetup.ts"],
    // PGlite is a single in-process WASM instance — running multiple
    // test files in parallel against the same socket leaks connections
    // and triggers ECONNRESET. Serialize file execution instead.
    fileParallelism: false,
    env: {
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
      WORKOS_API_KEY: "test_api_key",
      WORKOS_CLIENT_ID: "test_client_id",
      WORKOS_COOKIE_PASSWORD: "test_cookie_password_at_least_32_chars!",
      NODE_ENV: "test",
    },
  },
});
