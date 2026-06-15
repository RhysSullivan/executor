import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "src/server.ts",
    shared: "src/shared.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//],
});
