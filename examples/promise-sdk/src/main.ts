/**
 * Example: Promise-based executor SDK with MCP, OpenAPI, GraphQL,
 * and a custom plugin — no Effect knowledge needed.
 */
import { createExecutor, definePlugin } from "@executor/sdk";
import { mcpPlugin } from "@executor/plugin-mcp";
import { openApiPlugin } from "@executor/plugin-openapi";
import { graphqlPlugin } from "@executor/plugin-graphql";
import { ToolRegistration, ToolInvocationResult, ToolId } from "@executor/sdk";

// ---------------------------------------------------------------------------
// 1. Define a custom plugin using only async/await
// ---------------------------------------------------------------------------

const weatherPlugin = definePlugin({
  key: "weather",
  init: async (ctx) => {
    await ctx.tools.registerInvoker("weather", {
      invoke: async (_toolId, args) => {
        const { city } = args as { city: string };
        return new ToolInvocationResult({
          data: { city, temperature: 72, condition: "sunny" },
          error: null,
        });
      },
    });

    await ctx.tools.register([
      new ToolRegistration({
        id: ToolId.make("weather.getForecast"),
        pluginKey: "weather",
        sourceId: "weather",
        name: "getForecast",
        description: "Get weather forecast for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }),
    ]);

    return {
      extension: {
        forecast: async (city: string) => {
          const result = await ctx.tools.invoke(
            "weather.getForecast",
            { city },
            { onElicitation: "accept-all" },
          );
          return result.data as { city: string; temperature: number; condition: string };
        },
      },
      close: async () => {
        await ctx.tools.unregister(["weather.getForecast"]);
      },
    };
  },
});

// ---------------------------------------------------------------------------
// 2. Create the executor with all plugins
// ---------------------------------------------------------------------------

const executor = await createExecutor({
  scope: { name: "my-app" },
  plugins: [
    mcpPlugin(),
    openApiPlugin(),
    graphqlPlugin(),
    weatherPlugin,
  ] as const,
});

// ---------------------------------------------------------------------------
// 3. Custom plugin
// ---------------------------------------------------------------------------

const forecast = await executor.weather.forecast("San Francisco");
console.log("Weather:", forecast);

// ---------------------------------------------------------------------------
// 4. MCP — connect to remote or local servers
// ---------------------------------------------------------------------------

// Remote server
await executor.mcp.addSource({
  transport: "remote",
  name: "Context7",
  endpoint: "https://mcp.context7.com/mcp",
});

// Stdio server
// await executor.mcp.addSource({
//   transport: "stdio",
//   name: "My Server",
//   command: "npx",
//   args: ["-y", "@my/mcp-server"],
// });

// ---------------------------------------------------------------------------
// 5. OpenAPI — load specs by URL
// ---------------------------------------------------------------------------

await executor.openapi.addSpec({
  spec: "https://petstore3.swagger.io/api/v3/openapi.json",
  namespace: "petstore",
});

// With auth headers (static or secret-backed)
// await executor.secrets.set({
//   id: "stripe-key",
//   name: "Stripe Key",
//   value: "sk_live_...",
// });
// await executor.openapi.addSpec({
//   spec: "https://raw.githubusercontent.com/.../stripe.json",
//   namespace: "stripe",
//   headers: {
//     Authorization: { secretId: "stripe-key", prefix: "Bearer " },
//   },
// });

// ---------------------------------------------------------------------------
// 6. GraphQL — introspect endpoints
// ---------------------------------------------------------------------------

await executor.graphql.addSource({
  endpoint: "https://graphql.anilist.co",
  namespace: "anilist",
});

// With auth
// await executor.graphql.addSource({
//   endpoint: "https://api.github.com/graphql",
//   namespace: "github",
//   headers: {
//     Authorization: { secretId: "github-token", prefix: "Bearer " },
//   },
// });

// ---------------------------------------------------------------------------
// 7. Unified tool catalog — all plugins, one list
// ---------------------------------------------------------------------------

const tools = await executor.tools.list();
console.log(`\n${tools.length} tools across all plugins:`);
for (const t of tools) {
  console.log(`  [${t.pluginKey}] ${t.id} — ${t.description ?? ""}`);
}

// Get schema for any tool
const firstTool = tools.find((t) => t.pluginKey === "openapi" && t.sourceId === "petstore");
if (firstTool) {
  const schema = await executor.tools.schema(firstTool.id);
  console.log(`\n${firstTool.name} input: ${schema.inputTypeScript}`);
}

// ---------------------------------------------------------------------------
// 8. Invoke tools — same interface regardless of plugin
// ---------------------------------------------------------------------------

const result = await executor.tools.invoke(
  "weather.getForecast",
  { city: "Tokyo" },
  {
    onElicitation: async (ctx) => {
      console.log("Approval requested:", ctx.request);
      return { action: "accept" };
    },
  },
);
console.log("\nResult:", result.data);

// ---------------------------------------------------------------------------
// 9. Secrets — shared across all plugins
// ---------------------------------------------------------------------------

await executor.secrets.set({
  id: "api-key",
  name: "Shared API Key",
  value: "sk_...",
  purpose: "authentication",
});

const resolved = await executor.secrets.resolve("api-key");
console.log("Secret:", resolved);

await executor.close();
