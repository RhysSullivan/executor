import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  root: path.resolve(__dirname, "src/shell"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, "src/shell/mcp-app.html"),
    },
  },
  resolve: {
    alias: {
      // Ensure consistent React resolution
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },
});
