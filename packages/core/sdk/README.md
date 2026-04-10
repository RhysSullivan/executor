# @executor/sdk

A TypeScript SDK for building executors that wire together tool sources, secrets, and policies across MCP, OpenAPI, GraphQL, and custom plugins.

Everything is `async`/`await`. Plug in any combination of plugins, register your own tools, and invoke them through a unified catalog.

## Install

```sh
bun add @executor/sdk
# or
npm install @executor/sdk
```

## Quick start

```ts
import {
  createExecutor,
  definePlugin,
  ToolRegistration,
  ToolId,
  ToolInvocationResult,
} from "@executor/sdk";

// Define a custom plugin with async/await.
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
    };
  },
});

const executor = await createExecutor({
  scope: { name: "my-app" },
  plugins: [weatherPlugin] as const,
});

// The plugin's extension is available under its key.
const forecast = await executor.weather.forecast("San Francisco");

// Every plugin contributes to a unified tool catalog.
const tools = await executor.tools.list();

// Invoke any tool with the same call shape.
const result = await executor.tools.invoke(
  "weather.getForecast",
  { city: "Tokyo" },
  { onElicitation: "accept-all" },
);

await executor.close();
```

## Using plugins

Install whichever plugins you need and pass their factory call into `plugins`:

```ts
import { createExecutor } from "@executor/sdk";
import { mcpPlugin } from "@executor/plugin-mcp";
import { openApiPlugin } from "@executor/plugin-openapi";
import { graphqlPlugin } from "@executor/plugin-graphql";

const executor = await createExecutor({
  scope: { name: "my-app" },
  plugins: [mcpPlugin(), openApiPlugin(), graphqlPlugin()] as const,
});

await executor.mcp.addSource({
  transport: "remote",
  name: "Context7",
  endpoint: "https://mcp.context7.com/mcp",
});
await executor.openapi.addSpec({
  spec: "https://petstore3.swagger.io/api/v3/openapi.json",
  namespace: "petstore",
});
await executor.graphql.addSource({ endpoint: "https://graphql.anilist.co", namespace: "anilist" });

const tools = await executor.tools.list();
```

Available plugins:

- [`@executor/plugin-mcp`](https://www.npmjs.com/package/@executor/plugin-mcp) — Model Context Protocol (stdio + remote)
- [`@executor/plugin-openapi`](https://www.npmjs.com/package/@executor/plugin-openapi) — OpenAPI specs as tools
- [`@executor/plugin-graphql`](https://www.npmjs.com/package/@executor/plugin-graphql) — GraphQL endpoints as tools
- [`@executor/plugin-google-discovery`](https://www.npmjs.com/package/@executor/plugin-google-discovery) — Google Discovery APIs
- [`@executor/plugin-file-secrets`](https://www.npmjs.com/package/@executor/plugin-file-secrets) — file-backed secret store
- [`@executor/plugin-keychain`](https://www.npmjs.com/package/@executor/plugin-keychain) — OS keychain secret store
- [`@executor/plugin-onepassword`](https://www.npmjs.com/package/@executor/plugin-onepassword) — 1Password secret source

## Secrets

Secrets are scoped per executor and shared across every plugin that resolves them:

```ts
await executor.secrets.set({
  id: "github-token",
  name: "GitHub Token",
  value: "ghp_...",
  purpose: "authentication",
});

const value = await executor.secrets.resolve("github-token");
```

Plugins accept `{ secretId, prefix }` wherever a header value is expected, so you never write tokens into source configs.

## Using with Effect

The SDK is built on [Effect](https://effect.website/) under the hood. If you want the raw Effect-based primitives instead of the promise wrapper, import from the `/core` subpath:

```ts
import { createExecutor } from "@executor/sdk";
```

`/core` exposes `createExecutor` returning an `Effect`, the `ToolRegistry` / `SourceRegistry` / `SecretStore` / `PolicyEngine` Context tags, the in-memory store factories, and every branded ID + error class. Every `@executor/plugin-*` ships a matching `/core` subpath.

## Status

Pre-`1.0`. APIs may still change between beta releases. See the [executor monorepo](https://github.com/RhysSullivan/executor) for the current development branch and roadmap.

## License

MIT
