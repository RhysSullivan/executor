import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "testing/conformance": "src/testing/conformance.ts",
    "testing/memory": "src/testing/memory.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor\//, /^effect/, /^@effect\//, "vitest"],
});
