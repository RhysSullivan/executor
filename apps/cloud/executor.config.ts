import {
  defineExecutorConfig,
  type ConfigPluginDeps,
} from "@executor-js/sdk";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { graphqlPlugin } from "@executor-js/plugin-graphql";
import { workosVaultPlugin } from "@executor-js/plugin-workos-vault";

// ---------------------------------------------------------------------------
// Single source of truth for the cloud app's plugin list.
//
// Consumed by:
//   - the schema-gen CLI (reads `plugin.schema` only; calls `plugins({})`)
//   - the host runtime (calls `plugins({ workosCredentials })` per request)
//   - the test harness (calls `plugins({ workosVaultClient })` per test)
//
// Cloud only ships plugins safe to run in a multi-tenant setting — no
// stdio MCP, no keychain/file-secrets/1password/google-discovery.
// ---------------------------------------------------------------------------

declare module "@executor-js/sdk" {
  interface ConfigPluginDeps {
    /** WorkOS vault credentials. Provided per-request from `env.WORKOS_*`
     *  in production; the test harness leaves this undefined and uses
     *  `workosVaultClient` to inject an in-memory fake instead. */
    readonly workosCredentials?: {
      readonly apiKey: string;
      readonly clientId: string;
    };
    /** Pluggable WorkOS Vault HTTP client — set by the test harness to
     *  bypass the real WorkOS API. Production leaves this undefined and
     *  falls back to the credential-driven default. */
    readonly workosVaultClient?: import(
      "@executor-js/plugin-workos-vault"
    ).WorkOSVaultClient;
  }
}

export default defineExecutorConfig({
  dialect: "pg",
  plugins: ({ workosCredentials, workosVaultClient }) =>
    [
      openApiPlugin(),
      mcpPlugin({ dangerouslyAllowStdioMCP: false }),
      graphqlPlugin(),
      workosVaultPlugin({
        credentials: workosCredentials ?? { apiKey: "", clientId: "" },
        ...(workosVaultClient ? { client: workosVaultClient } : {}),
      }),
    ] as const,
});
