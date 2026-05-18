// Minimal stdio MCP server used by the stdio updateSource tests.
//
// Reads `FIXTURE_TOOLS` from env (comma-separated tool names) and exposes
// each as a no-op tool. Reads `FIXTURE_NAME` (default "stdio-fixture") as
// the advertised server name. The test spawns this via:
//
//   command: "bun", args: ["run", <path-to-this-file>],
//   env: { FIXTURE_TOOLS: "alpha,beta", FIXTURE_NAME: "fixture-a" }
//
// Changing env or args between addSource and updateSource gives us a
// deterministic way to assert tool re-discovery on update.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import z from "zod";

const toolNames = (process.env.FIXTURE_TOOLS ?? "alpha")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const server = new McpServer({
  name: process.env.FIXTURE_NAME ?? "stdio-fixture",
  version: "0.0.0",
});

for (const name of toolNames) {
  server.registerTool(
    name,
    {
      description: `Fixture tool ${name}`,
      inputSchema: { value: z.string().optional() },
    },
    async () => ({ content: [{ type: "text", text: `ok:${name}` }] }),
  );
}

await server.connect(new StdioServerTransport());
