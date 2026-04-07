import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_PORT = process.env.API_PORT ?? "3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.0.0"),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify("https://github.com/RhysSullivan/executor"),
  },
  resolve: {
    alias: {
      "@web": resolve(__dirname, "../local/src/web"),
    },
  },
  server: {
    proxy: {
      "/v1": `http://localhost:${API_PORT}`,
      "/auth": `http://localhost:${API_PORT}`,
      "/api": `http://localhost:${API_PORT}`,
      "/docs": `http://localhost:${API_PORT}`,
      "/openapi.json": `http://localhost:${API_PORT}`,
    },
  },
});
