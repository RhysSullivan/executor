import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    hookTimeout: 30_000,
    globalSetup: ["./scripts/test-globalsetup.ts"],
  },
});
