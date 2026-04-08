import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createEnv, Env } from "@executor/env";

const server = {
  PORT: Env.numberOr("PORT", 5173),
};

type ViteEnv = Readonly<{
  PORT: number;
}>;

const viteEnv = createEnv(server, {
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
}) as ViteEnv;

export default defineConfig({
  server: {
    port: viteEnv.PORT,
    host: "127.0.0.1",
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackStart({
      spa: { enabled: true },
    }),
    react(),
  ],
});
