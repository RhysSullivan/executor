import { defineExecutorConfig, type ConfigPluginDeps } from "@executor-js/sdk";
import type { ConfigFileSink } from "@executor-js/config";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { googleDiscoveryPlugin } from "@executor-js/plugin-google-discovery";
import { graphqlPlugin } from "@executor-js/plugin-graphql";
import { keychainPlugin } from "@executor-js/plugin-keychain";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { onepasswordPlugin } from "@executor-js/plugin-onepassword";
import { examplePlugin } from "@executor-js/plugin-example/server";

// ---------------------------------------------------------------------------
// Single source of truth for the local app's plugin list.
//
// Consumed by:
//   - the schema-gen CLI (reads `plugin.schema` only; calls `plugins({})`)
//   - the host runtime (calls `plugins({ configFile })` with a real sink)
//
// First-party and third-party plugins use the same import-and-call flow.
// ---------------------------------------------------------------------------

declare module "@executor-js/sdk" {
  interface ConfigPluginDeps {
    readonly configFile?: ConfigFileSink;
  }
}

export default defineExecutorConfig({
  dialect: "sqlite",
  plugins: ({ configFile }: ConfigPluginDeps) => [
    openApiPlugin({ configFile }),
    mcpPlugin({ dangerouslyAllowStdioMCP: true, configFile }),
    googleDiscoveryPlugin(),
    graphqlPlugin({ configFile }),
    keychainPlugin(),
    fileSecretsPlugin(),
    onepasswordPlugin(),
    examplePlugin(),
  ],
});
