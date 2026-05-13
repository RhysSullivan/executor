// @ts-check
import { defineConfig } from "astro/config";

import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";

import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  site: "https://executor.sh",
  output: "server",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },

  adapter: cloudflare(),
});
