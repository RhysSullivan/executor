import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [
    /^effect/,
    /^@effect\//,
    "commander",
    "jiti",
  ],
});
