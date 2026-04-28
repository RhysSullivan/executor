/**
 * Example: Promise-based executor SDK with MCP, OpenAPI, and GraphQL
 * — no Effect knowledge needed. In-memory stores, runs anywhere.
 */
import { createExecutor, SecretId, SetSecretInput } from "@executor/sdk/promise";
import { mcpPlugin } from "@executor/plugin-mcp/promise";
import { openApiPlugin } from "@executor/plugin-openapi/promise";
import { graphqlPlugin } from "@executor/plugin-graphql/promise";

// ---------------------------------------------------------------------------
// 1. Create the executor with all plugins
// ---------------------------------------------------------------------------

const executor = await createExecutor({
  scopes: [{ id: "my-app", name: "my-app" }],
  plugins: [mcpPlugin(), openApiPlugin(), graphqlPlugin()] as const,
});

// ---------------------------------------------------------------------------
// 2. MCP — connect to remote or local servers
// ---------------------------------------------------------------------------

await executor.mcp.addSource({
  transport: "remote",
  name: "Context7",
  endpoint: "https://mcp.context7.com/mcp",
  scope: "my-app",
});

// Stdio server
// await executor.mcp.addSource({
//   transport: "stdio",
//   name: "My Server",
//   command: "npx",
//   args: ["-y", "@my/mcp-server"],
// });

// ---------------------------------------------------------------------------
// 3. OpenAPI — load specs by URL
// ---------------------------------------------------------------------------

await executor.openapi.addSpec({
  spec: "https://petstore3.swagger.io/api/v3/openapi.json",
  namespace: "petstore",
  scope: "my-app",
});

// With auth headers (static or secret-backed)
// await executor.secrets.set(
//   new SetSecretInput({ id: "stripe-key", name: "Stripe Key", value: "sk_live_..." }),
// );
// await executor.openapi.addSpec({
//   spec: "https://raw.githubusercontent.com/.../stripe.json",
//   namespace: "stripe",
//   headers: {
//     Authorization: { secretId: "stripe-key", prefix: "Bearer " },
//   },
// });

// ---------------------------------------------------------------------------
// 4. GraphQL — introspect endpoints
// ---------------------------------------------------------------------------

await executor.graphql.addSource({
  endpoint: "https://graphql.anilist.co",
  namespace: "anilist",
  scope: "my-app",
});

// ---------------------------------------------------------------------------
// 5. Unified tool catalog — all plugins, one list
// ---------------------------------------------------------------------------

const tools = await executor.tools.list();
console.log(`\n${tools.length} tools across all plugins:`);
for (const t of tools) {
  console.log(`  [${t.pluginId}] ${t.id} — ${t.description}`);
}

const firstPetstoreTool = tools.find((t) => t.sourceId === "petstore");
if (firstPetstoreTool) {
  const schema = await executor.tools.schema(firstPetstoreTool.id);
  console.log(`\n${firstPetstoreTool.name} input: ${schema?.inputTypeScript ?? "<none>"}`);
}

// ---------------------------------------------------------------------------
// 6. Invoke tools — same interface regardless of plugin
// ---------------------------------------------------------------------------

const anilistTool = tools.find((t) => t.sourceId === "anilist");
if (anilistTool) {
  const result = await executor.tools.invoke(anilistTool.id, {});
  console.log("\nResult:", result);
}

// ---------------------------------------------------------------------------
// 7. Secrets — shared across all plugins
// ---------------------------------------------------------------------------

await executor.secrets.set(
  new SetSecretInput({
    id: SecretId.make("api-key"),
    scope: "my-app" as SetSecretInput["scope"],
    name: "Shared API Key",
    value: "sk_...",
  }),
);

const resolved = await executor.secrets.get("api-key");
console.log("Secret:", resolved);

await executor.close();
