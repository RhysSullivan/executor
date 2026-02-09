import { expect, test } from "bun:test";
import { loadExternalTools } from "./tool_sources";
import type { ExternalToolSourceConfig } from "./tool_sources";

function makeInlineSpec(tag: string, operationId: string): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: tag, version: "1.0.0" },
    servers: [{ url: "https://example.com" }],
    paths: {
      [`/${operationId}`]: {
        get: {
          operationId,
          tags: [tag],
          summary: `${tag} ${operationId}`,
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

/**
 * Start a fake MCP server that introduces an artificial delay, then responds
 * with a valid tool list. MCP uses HTTP so we can control latency precisely.
 * This is served as a Streamable HTTP endpoint (POST /mcp with JSON-RPC).
 */
function makeFakeMcpServer(delayMs: number, toolName: string) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      await Bun.sleep(delayMs);

      const body = (await req.json()) as { method?: string; id?: unknown };

      // MCP initialization
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: `fake-${toolName}`, version: "0.1.0" },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      // MCP initialized notification — no response needed for notifications
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 204 });
      }

      // MCP tools/list
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: toolName,
                  description: `Tool ${toolName}`,
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Not found" } }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  return { server, url: `http://127.0.0.1:${server.port}` };
}

test("loadExternalTools loads multiple sources concurrently, not sequentially", async () => {
  const DELAY_MS = 150;
  const SOURCE_COUNT = 5;
  // Sequential: 5 sources * 150ms/request * 3 round-trips = 2250ms minimum
  // Concurrent: ~150ms * 3 round-trips + overhead = ~600ms
  // MCP needs multiple round-trips (initialize, notifications/initialized, tools/list)
  // so we set the threshold well below what sequential would take.
  const MAX_SEQUENTIAL_MS = DELAY_MS * SOURCE_COUNT * 3; // 2250ms
  const MAX_CONCURRENT_MS = MAX_SEQUENTIAL_MS / 2; // 1125ms — must be less than half sequential

  const mcpServers: ReturnType<typeof makeFakeMcpServer>[] = [];
  const sources: ExternalToolSourceConfig[] = [];

  for (let i = 0; i < SOURCE_COUNT; i++) {
    const mcp = makeFakeMcpServer(DELAY_MS, `tool_${i}`);
    mcpServers.push(mcp);
    sources.push({
      type: "mcp",
      name: `delayed-mcp-${i}`,
      url: mcp.url,
      transport: "streamable-http",
    });
  }

  try {
    const start = performance.now();
    const { tools, warnings } = await loadExternalTools(sources);
    const elapsed = performance.now() - start;

    // All sources should have loaded successfully
    expect(warnings).toHaveLength(0);
    expect(tools).toHaveLength(SOURCE_COUNT);

    for (let i = 0; i < SOURCE_COUNT; i++) {
      const paths = tools.map((t) => t.path);
      expect(paths).toContain(`delayed_mcp_${i}.tool_${i}`);
    }

    // Critical assertion: total time should be close to a single delay,
    // not the sum of all delays. This proves concurrent loading.
    expect(elapsed).toBeLessThan(MAX_CONCURRENT_MS);
  } finally {
    for (const mcp of mcpServers) {
      mcp.server.stop(true);
    }
  }
});

test("loadExternalTools captures individual source failures without blocking others", async () => {
  const goodSpec = makeInlineSpec("default", "ok");

  const { tools, warnings } = await loadExternalTools([
    {
      type: "openapi",
      name: "good",
      spec: goodSpec,
      baseUrl: "https://example.com",
    },
    {
      type: "openapi",
      name: "bad",
      spec: "http://127.0.0.1:1/nonexistent",
      baseUrl: "https://example.com",
    },
    {
      type: "openapi",
      name: "also-good",
      spec: goodSpec,
      baseUrl: "https://example.com",
    },
  ]);

  // Both good sources should have loaded
  expect(tools.length).toBeGreaterThanOrEqual(2);
  const toolPaths = tools.map((t) => t.path);
  expect(toolPaths).toContain("good.default.ok");
  expect(toolPaths).toContain("also_good.default.ok");

  // The bad source should produce a warning, not crash everything
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("bad");
});

test("loadExternalTools tolerates OpenAPI specs with broken internal refs", async () => {
  const brokenRefSpec: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title: "Broken refs", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/contacts": {
        get: {
          operationId: "listContacts",
          tags: ["contacts"],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/contact_list" },
                },
              },
            },
          },
        },
      },
      "/conversations": {
        post: {
          operationId: "createConversation",
          tags: ["conversations"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/create_conversation_request" },
              },
            },
          },
          responses: {
            "200": { description: "ok" },
          },
        },
      },
    },
    components: {
      schemas: {
        create_conversation_request: {
          type: "object",
          properties: {
            body: { type: "string" },
            custom_attributes: { $ref: "#/components/schemas/custom_attributes" },
          },
        },
      },
    },
  };

  const { tools, warnings } = await loadExternalTools([
    {
      type: "openapi",
      name: "intercom-like",
      spec: brokenRefSpec,
      baseUrl: "https://api.example.com",
    },
  ]);

  expect(warnings).toHaveLength(0);
  const toolPaths = tools.map((t) => t.path);
  expect(toolPaths).toContain("intercom_like.contacts.listcontacts");
  expect(toolPaths).toContain("intercom_like.conversations.createconversation");
});
