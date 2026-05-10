import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/sdk/index.ts",
    promise: "src/promise.ts",
    testing: "src/sdk/testing.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@workos-inc\/node/],
});
