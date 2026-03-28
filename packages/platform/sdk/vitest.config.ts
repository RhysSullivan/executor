import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@executor\/platform-api\/http$/,
        replacement: new URL("../api/src/http.ts", import.meta.url).pathname,
      },
      {
        find: /^@executor\/platform-api$/,
        replacement: new URL("../api/src/index.ts", import.meta.url).pathname,
      },
      {
        find: /^@executor\/platform-sdk-file\/effect$/,
        replacement: new URL("../sdk-file/src/effect.ts", import.meta.url).pathname,
      },
      {
        find: /^@executor\/platform-sdk-file\/runtime$/,
        replacement: new URL("../sdk-file/src/runtime.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
