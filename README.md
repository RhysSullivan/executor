# executor

[https://github.com/user-attachments/assets/11225f83-e848-42ba-99b2-a993bcc88dad](https://github.com/user-attachments/assets/11225f83-e848-42ba-99b2-a993bcc88dad)

The integration layer for AI agents. One catalog for every tool, shared across every agent you use.

[Ask DeepWiki](https://deepwiki.com/RhysSullivan/executor)

## Quick start

```bash
npm install -g executor
executor web
```

This starts a local runtime with a web UI at `http://127.0.0.1:8788`. From there, add your first source and start using tools.

### Use as an MCP server

Point any MCP-compatible agent (Cursor, Claude Code, OpenCode, etc.) at Executor to share your tool catalog, auth, and policies across all of them.

```bash
# HTTP
executor mcp

# stdio (for agent configs)
executor mcp --stdio
```

Example `mcp.json` for Claude Code / Cursor:

```json
{
  "mcpServers": {
    "executor": {
      "command": "executor",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

## Add a source

If you can represent it with a JSON schema, it can be an integration. Executor has first-party support for OpenAPI, GraphQL, MCP, and Google Discovery — but the plugin system is open to any source type.

### Via the web UI

Open `http://127.0.0.1:8788`, go to **Add Source**, paste a URL, and Executor will detect the type, index the tools, and handle auth.

### Via the CLI

```bash
executor call 'return await tools.executor.sources.add({
  kind: "openapi",
  name: "GitHub",
  specUrl: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
  baseUrl: null,
  auth: { kind: "none" }
})'
```

## Use tools

Agents discover and call tools through a typed TypeScript runtime:

```ts
// discover by intent
const matches = await tools.discover({ query: "github issues", limit: 5 });

// inspect the schema
const detail = await tools.describe.tool({
  path: matches.bestPath,
  includeSchemas: true,
});

// call with type safety
const issues = await tools.github.issues.list({
  owner: "vercel",
  repo: "next.js",
});
```

Run code via the CLI:

```bash
executor call --file script.ts
executor call 'return await tools.discover({ query: "send email" })'
```

If an execution pauses for auth or approval, resume it:

```bash
executor resume --execution-id exec_123
```

## CLI reference

```bash
executor web                        # start runtime + web UI
executor mcp                        # start MCP endpoint (HTTP)
executor mcp --stdio                # start MCP endpoint (stdio)
executor call --file script.ts      # execute a file
executor call '<code>'              # execute inline code
executor call --stdin               # execute from stdin
executor resume --execution-id <id> # resume paused execution
executor up / down / status         # daemon lifecycle
```

## Developing locally

```bash
bun install
bun dev
```

The dev server starts at `http://127.0.0.1:8788`.

## Community

Join the Discord: [https://discord.gg/eF29HBHwM6](https://discord.gg/eF29HBHwM6)

## Learn more

Visit [executor.sh](https://executor.sh) to learn more.

## Attribution

- Thank you to [Crystian](https://www.linkedin.com/in/crystian/) for providing the npm package name `executor`.
