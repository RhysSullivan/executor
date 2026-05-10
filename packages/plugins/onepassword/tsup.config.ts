import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/sdk/index.ts",
    promise: "src/promise.ts",
    client: "src/react/plugin-client.tsx",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//],
});
