import { defineExecutorConfig } from "@executor-js/sdk";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { encryptedSecretsPlugin } from "@executor-js/plugin-encrypted-secrets";

// ---------------------------------------------------------------------------
// Plugin list for the Cloudflare web build. The Vite `executorVitePlugin` reads
// this to assemble `virtual:executor/plugins-client` (the client-side plugin
// bundles the shell renders). It mirrors the runtime list in src/plugins.ts —
// same protocol/provider plugins as self-host. The encrypted-secrets key only
// matters at runtime (server side); a build-time placeholder is fine here since
// the client bundle never holds the key.
// ---------------------------------------------------------------------------

export default defineExecutorConfig({
  plugins: () =>
    [
      openApiHttpPlugin(),
      mcpHttpPlugin({ dangerouslyAllowStdioMCP: false }),
      graphqlHttpPlugin(),
      encryptedSecretsPlugin({ key: process.env.EXECUTOR_SECRET_KEY ?? "build-time-placeholder" }),
    ] as const,
});
