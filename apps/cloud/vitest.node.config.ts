// Vitest config for node-pool integration tests. These run real DbService,
// real plugins, and HttpApiClient through an in-process handler, but outside
// workerd. Node can use Drizzle's PGlite driver directly; the workerd suite
// keeps the PGlite socket path because Workers code reaches Postgres through
// postgres.js.

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
    // Keep files serialized so tests share one deterministic PGlite state.
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
