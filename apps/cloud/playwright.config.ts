import { defineConfig, devices } from "@playwright/test";

// ---------------------------------------------------------------------------
// Playwright e2e for the cloud app. Boots the real Vite dev server (stub env,
// throwaway PGlite — see e2e/e2e-server.ts) and drives it in a real browser, so
// failures that only surface during client hydration (the TanStack Start client
// entry not loading) are caught. The Vitest suites can't see these — they exercise
// the HTTP handler, not the browser module graph.
// ---------------------------------------------------------------------------

const PORT = 4798;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // One dev server; keep it serial + non-parallel so the assertions are stable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // Drive the system Chrome by default (no Chromium download needed); CI sets
      // PLAYWRIGHT_USE_CHROMIUM=1 to use the Playwright-managed browser instead.
      use: process.env.PLAYWRIGHT_USE_CHROMIUM
        ? { ...devices["Desktop Chrome"] }
        : { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "bun run e2e/e2e-server.ts",
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
