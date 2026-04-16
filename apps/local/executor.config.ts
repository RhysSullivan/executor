import { defineExecutorConfig } from "@executor/sdk";
import { openApiPlugin } from "@executor/plugin-openapi";
import { mcpPlugin } from "@executor/plugin-mcp";
import { googleDiscoveryPlugin } from "@executor/plugin-google-discovery";
import { graphqlPlugin } from "@executor/plugin-graphql";

// ---------------------------------------------------------------------------
// Executor config for CLI schema generation (local / sqlite).
//
// The CLI reads `plugins` + `dialect` to produce a drizzle schema file.
// Only plugins with a `schema` need to be listed — keychain,
// file-secrets, and onepassword are runtime-only (no DB tables).
// ---------------------------------------------------------------------------

export default defineExecutorConfig({
  dialect: "sqlite",
  plugins: [
    openApiPlugin(),
    mcpPlugin({ dangerouslyAllowStdioMCP: true }),
    googleDiscoveryPlugin(),
    graphqlPlugin(),
  ],
});
