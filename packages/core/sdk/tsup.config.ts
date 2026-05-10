import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    promise: "src/promise.ts",
    client: "src/client.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^effect/, /^@effect\//, "react"],
});
