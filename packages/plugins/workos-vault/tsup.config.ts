import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/promise.ts",
    core: "src/sdk/index.ts",
    testing: "src/sdk/testing.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@workos-inc\/node/],
});
