import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    promise: "src/promise.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//],
});
