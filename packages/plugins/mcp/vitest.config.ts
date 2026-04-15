import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/sdk/**/*.test.ts"],
  },
});
