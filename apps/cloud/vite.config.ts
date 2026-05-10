import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import executorVitePlugin from "@executor-js/vite-plugin";

const PUBLIC_VARS = {
  VITE_PUBLIC_SITE_URL: "https://executor.sh",
  VITE_PUBLIC_POSTHOG_KEY: "phc_nNLrNMALpRsfrEkZovUkfMxYbcJvHnsJHeoSPavprgLL",
};

// VITE_PUBLIC_ANALYTICS_PATH is generated once per build by `scripts/build.mjs`
// and inherited via process.env, so the client and SSR/Cloudflare environment
// builds bake the same value. The fallback "a" is for `vite dev`, where the
// proxy isn't routed anyway.
const ANALYTICS_PATH = process.env.VITE_PUBLIC_ANALYTICS_PATH ?? "a";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const publicEnv = {
    ...PUBLIC_VARS,
    VITE_PUBLIC_ANALYTICS_PATH: ANALYTICS_PATH,
    ...env,
  };

  return {
    build: {
      rollupOptions: {
        external: ["cloudflare:workers"],
      },
    },
    define: Object.fromEntries(
      Object.entries(publicEnv)
        .filter(([key]) => key.startsWith("VITE_PUBLIC_"))
        .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
    ),
    resolve: { tsconfigPaths: true },
    plugins: [tailwindcss(), executorVitePlugin(), tanstackStart(), react()],
  };
});
