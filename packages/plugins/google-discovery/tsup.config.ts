import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/public.ts",
    core: "src/sdk/index.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor\//, /^effect/, /^@effect\//],
});
