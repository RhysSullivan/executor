import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import devServer from "@hono/vite-dev-server";

type ExecutorPackageMetadata = {
  version: string;
  homepage?: string;
  repository?: string | { url?: string };
};

const executorPackage = JSON.parse(
  readFileSync(new URL("../executor/package.json", import.meta.url), "utf8"),
) as ExecutorPackageMetadata;

const repositoryUrl =
  typeof executorPackage.repository === "string"
    ? executorPackage.repository
    : executorPackage.repository?.url;

const githubUrl = (executorPackage.homepage ?? repositoryUrl ?? "https://github.com/RhysSullivan/executor")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");

const webPackage = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
};

const workspaceExecutorPackages = Object.keys(webPackage.dependencies ?? {}).filter(
  (name) => name.startsWith("@executor/"),
);

export default defineConfig({
  root: "src",
  plugins: [
    tailwindcss(),
    react(),
    devServer({
      entry: "src/dev.ts",
      exclude: [
        // Only let /v1 and /mcp requests reach the API handler
        /^\/(?!(v1|mcp)(\/|$))/,
        /^\/(src|node_modules|@vite|@id|@react-refresh)/,
        /\.(css|ts|tsx|js|jsx|svg|png|jpg|gif|ico|woff2?|json|map)(\?.*)?$/,
      ],
      injectClientScript: false,
    }),
  ],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(executorPackage.version),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify(githubUrl),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: workspaceExecutorPackages,
  },
  server: {
    port: 8788,
    allowedHosts: [
      "rhyss-laptop.tail5665af.ts.net",
      ".tail5665af.ts.net",
    ],
    watch: {
      ignored: [
        "!**/node_modules/@executor/**",
      ],
    },
  },
});
