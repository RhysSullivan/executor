import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/client.tsx"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@executor-js/sdk", "react"],
});
