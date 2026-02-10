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
  expect(toolPaths).toContain("good.ok");
  expect(toolPaths).toContain("also_good.ok");

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
  expect(toolPaths).toContain("intercom_like.contacts.list_contacts");
  expect(toolPaths).toContain("intercom_like.conversations.create_conversation");
});

test("graphql helper tools generate valid selection sets and envelope responses", async () => {
  const capturedQueries: string[] = [];
  const capturedVariables: Array<Record<string, unknown> | undefined> = [];

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { query?: string; variables?: Record<string, unknown> };
      const query = String(body.query ?? "");
      capturedQueries.push(query);
      capturedVariables.push(body.variables);

      if (query.includes("__schema")) {
        return Response.json({
          data: {
            __schema: {
              queryType: { name: "Query" },
              mutationType: { name: "Mutation" },
              types: [
                {
                  kind: "OBJECT",
                  name: "Query",
                  fields: [
                    {
                      name: "teams",
                      description: null,
                      args: [],
                      type: { kind: "OBJECT", name: "TeamConnection", ofType: null },
                    },
                  ],
                  inputFields: null,
                  enumValues: null,
                },
                {
                  kind: "OBJECT",
                  name: "Mutation",
                  fields: [
                    {
                      name: "issueBatchCreate",
                      description: null,
                      args: [
                        {
                          name: "input",
                          description: null,
                          defaultValue: null,
                          type: {
                            kind: "NON_NULL",
                            name: null,
                            ofType: { kind: "INPUT_OBJECT", name: "IssueBatchCreateInput", ofType: null },
                          },
                        },
                      ],
                      type: { kind: "OBJECT", name: "IssueBatchCreatePayload", ofType: null },
                    },
                  ],
                  inputFields: null,
                  enumValues: null,
                },
                {
                  kind: "OBJECT",
                  name: "TeamConnection",
                  fields: [
                    {
                      name: "totalCount",
                      description: null,
                      args: [],
                      type: { kind: "SCALAR", name: "Int", ofType: null },
                    },
                    {
                      name: "nodes",
                      description: null,
                      args: [],
                      type: {
                        kind: "LIST",
                        name: null,
                        ofType: { kind: "OBJECT", name: "Team", ofType: null },
                      },
                    },
                  ],
                  inputFields: null,
                  enumValues: null,
                },
                {
                  kind: "OBJECT",
                  name: "Team",
                  fields: [
                    {
                      name: "id",
                      description: null,
                      args: [],
                      type: { kind: "SCALAR", name: "ID", ofType: null },
                    },
                    {
                      name: "name",
                      description: null,
                      args: [],
                      type: { kind: "SCALAR", name: "String", ofType: null },
                    },
                  ],
                  inputFields: null,
                  enumValues: null,
                },
                {
                  kind: "OBJECT",
                  name: "IssueBatchCreatePayload",
                  fields: [
                    {
                      name: "success",
                      description: null,
                      args: [],
                      type: { kind: "SCALAR", name: "Boolean", ofType: null },
                    },
                    {
                      name: "issues",
                      description: null,
                      args: [],
                      type: {
                        kind: "LIST",
                        name: null,
                        ofType: { kind: "OBJECT", name: "Issue", ofType: null },
                      },
                    },
                  ],
                  inputFields: null,
                  enumValues: null,
                },
                {
                  kind: "OBJECT",
                  name: "Issue",
                  fields: [
                    {
                      name: "id",
                      description: null,
                      args: [],
                      type: { kind: "SCALAR", name: "ID", ofType: null },
                    },
                    {
                      name: "identifier",
                      description: null,
                      args: [],
                      type: { kind: "SCALAR", name: "String", ofType: null },
                    },
                  ],
                  inputFields: null,
                  enumValues: null,
                },
                {
                  kind: "INPUT_OBJECT",
                  name: "IssueBatchCreateInput",
                  fields: null,
                  inputFields: [
                    {
                      name: "issues",
                      description: null,
                      defaultValue: null,
                      type: {
                        kind: "LIST",
                        name: null,
                        ofType: { kind: "SCALAR", name: "String", ofType: null },
                      },
                    },
                  ],
                  enumValues: null,
                },
                { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
                { kind: "SCALAR", name: "ID", fields: null, inputFields: null, enumValues: null },
                { kind: "SCALAR", name: "Int", fields: null, inputFields: null, enumValues: null },
                { kind: "SCALAR", name: "Boolean", fields: null, inputFields: null, enumValues: null },
              ],
            },
          },
        });
      }

      if (query.includes("issueBatchCreate")) {
        if (!/issueBatchCreate(?:\([^)]*\))?\s*\{/.test(query)) {
          return Response.json({ errors: [{ message: "issueBatchCreate requires a selection set" }] });
        }
        return Response.json({
          data: {
            issueBatchCreate: {
              success: true,
              issues: [{ id: "issue_1", identifier: "RHY-1" }],
            },
          },
        });
      }

      if (query.includes("teams")) {
        if (!/teams(?:\([^)]*\))?\s*\{/.test(query)) {
          return Response.json({ errors: [{ message: "teams requires a selection set" }] });
        }
        return Response.json({
          data: {
            teams: {
              totalCount: 1,
              nodes: [{ id: "team_1", name: "Core" }],
            },
          },
        });
      }

      return Response.json({ errors: [{ message: "Unknown operation" }] });
    },
  });

  try {
    const { tools, warnings } = await loadExternalTools([
      {
        type: "graphql",
        name: "linear",
        endpoint: `http://127.0.0.1:${server.port}/graphql`,
      },
    ]);

    expect(warnings).toHaveLength(0);
    const toolMap = new Map(tools.map((tool) => [tool.path, tool]));

    const teamsTool = toolMap.get("linear.query.teams");
    const batchTool = toolMap.get("linear.mutation.issuebatchcreate");
    const rawTool = toolMap.get("linear.graphql");

    expect(teamsTool).toBeDefined();
    expect(batchTool).toBeDefined();
    expect(rawTool).toBeDefined();

    const context = { taskId: "t", workspaceId: "w", isToolAllowed: () => true };

    const teamsResult = await teamsTool!.run({}, context);
    const batchResult = await batchTool!.run({ input: { issues: ["one"] } }, context);
    const batchResultDoubleWrapped = await batchTool!.run({ input: { input: { issues: ["two"] } } }, context);
    const rawResult = await rawTool!.run({ query: "query { teams { totalCount } }" }, context);

    expect(teamsResult).toEqual({
      data: {
        totalCount: 1,
        nodes: [{ id: "team_1", name: "Core" }],
      },
      errors: [],
    });
    expect(batchResult).toEqual({
      data: {
        success: true,
        issues: [{ id: "issue_1", identifier: "RHY-1" }],
      },
      errors: [],
    });
    expect(batchResultDoubleWrapped).toEqual({
      data: {
        success: true,
        issues: [{ id: "issue_1", identifier: "RHY-1" }],
      },
      errors: [],
    });
    expect(rawResult).toEqual({
      data: {
        teams: {
          totalCount: 1,
          nodes: [{ id: "team_1", name: "Core" }],
        },
      },
      errors: [],
    });

    const helperQueries = capturedQueries.filter((query) => !query.includes("__schema"));
    const helperVariables = capturedVariables.slice(1);
    expect(helperQueries.some((query) => /teams(?:\([^)]*\))?\s*\{/.test(query))).toBe(true);
    expect(helperQueries.some((query) => /issueBatchCreate(?:\([^)]*\))?\s*\{/.test(query))).toBe(true);
    expect(helperQueries.some((query) => /teams(?:\([^)]*\))?\s*\{[^}]*nodes\s*\{/.test(query))).toBe(true);
    expect(helperQueries.some((query) => /issueBatchCreate(?:\([^)]*\))?\s*\{[^}]*issues\s*\{/.test(query))).toBe(true);
    expect(helperVariables.some((variables) => JSON.stringify(variables) === JSON.stringify({ input: { issues: ["one"] } }))).toBe(true);
    expect(helperVariables.some((variables) => JSON.stringify(variables) === JSON.stringify({ input: { issues: ["two"] } }))).toBe(true);
  } finally {
    server.stop(true);
  }
});
