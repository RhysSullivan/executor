import { defineExecutorConfig } from "@executor/sdk";
import { openApiPlugin } from "@executor/plugin-openapi";
import { mcpPlugin } from "@executor/plugin-mcp";
import { graphqlPlugin } from "@executor/plugin-graphql";
import { workosVaultPlugin } from "@executor/plugin-workos-vault";

// ---------------------------------------------------------------------------
// Executor config for CLI schema generation.
//
// The CLI reads `plugins` + `dialect` to produce a drizzle schema file.
// Plugin credentials are stubs — the CLI only reads `plugin.schema`,
// never calls the plugin at runtime.
// ---------------------------------------------------------------------------

export default defineExecutorConfig({
  dialect: "pg",
  plugins: [
    openApiPlugin(),
    mcpPlugin({ dangerouslyAllowStdioMCP: false }),
    graphqlPlugin(),
    workosVaultPlugin({
      credentials: { apiKey: "", clientId: "" },
    }),
  ],
});
