import { expect, test } from "bun:test";
import type { Id } from "../../database/convex/_generated/dataModel.d.ts";
import {
  compileExternalToolSource,
  loadExternalTools,
  materializeCompiledToolSource,
  parseGraphqlOperationPaths,
} from "./tool-sources";
import type { ExternalToolSourceConfig } from "./tool-sources";

const TEST_WORKSPACE_ID = "w" as Id<"workspaces">;

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
function makeFakeMcpServer(
  delayMs: number,
  toolName: string,
  options: { outputSchema?: unknown; callResult?: Record<string, unknown> } = {},
) {
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
                  ...(Object.prototype.hasOwnProperty.call(options, "outputSchema")
                    ? { outputSchema: options.outputSchema }
                    : {}),
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      if (body.method === "tools/call") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: options.callResult ?? {
              content: [{ type: "text", text: "ok" }],
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

test("mcp tools use outputSchema for return type hints when available", async () => {
  const mcp = makeFakeMcpServer(0, "get_status", {
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        retries: { type: "integer" },
      },
      required: ["ok"],
    },
  });

  try {
    const { tools, warnings } = await loadExternalTools([
      {
        type: "mcp",
        name: "status",
        url: mcp.url,
        transport: "streamable-http",
      },
    ]);

    expect(warnings).toHaveLength(0);
    expect(tools).toHaveLength(1);

    const tool = tools[0];
    expect(tool?.path).toBe("status.get_status");
    const output = tool?.typing?.outputSchema as Record<string, unknown> | undefined;
    expect(output).toBeDefined();
    const props = output && typeof output === "object" ? (output.properties as Record<string, unknown> | undefined) : undefined;
    expect(props).toBeDefined();
    expect(Object.keys(props ?? {})).toContain("ok");
    expect(Object.keys(props ?? {})).toContain("retries");
  } finally {
    mcp.server.stop(true);
  }
});

test("mcp tool execution preserves structured result envelope", async () => {
  const mcp = makeFakeMcpServer(0, "get_status", {
    callResult: {
      content: [{ type: "text", text: "fallback" }],
      structuredContent: { ok: true, retries: 2 },
      isError: false,
    },
  });

  try {
    const { tools, warnings } = await loadExternalTools([
      {
        type: "mcp",
        name: "status",
        url: mcp.url,
        transport: "streamable-http",
      },
    ]);

    expect(warnings).toHaveLength(0);
    expect(tools).toHaveLength(1);

    const result = await tools[0]!.run(
      {},
      { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
    ) as { structuredContent?: unknown; content?: unknown[]; isError?: boolean };

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, retries: 2 });
    expect(Array.isArray(result.content)).toBe(true);
  } finally {
    mcp.server.stop(true);
  }
});

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

test("compiled source artifacts can be materialized and executed", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ ok: true, probe: url.searchParams.get("probe") });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const spec: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title: "Compiled", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${server.port}` }],
    paths: {
      "/health": {
        get: {
          operationId: "healthCheck",
          tags: ["health"],
          parameters: [
            {
              name: "probe",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      probe: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  try {
    const artifact = await compileExternalToolSource({
      type: "openapi",
      name: "compiled-api",
      spec,
      baseUrl: `http://127.0.0.1:${server.port}`,
    });

    expect(artifact.version).toBe("v1");
    expect(artifact.sourceType).toBe("openapi");
    expect(artifact.tools).toHaveLength(1);
    expect(artifact.tools[0]?.runSpec.kind).toBe("openapi");

    const tools = materializeCompiledToolSource(artifact);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.path).toBe("compiled_api.health.check");

    const result = await tools[0]!.run(
      { query: { probe: "status" } },
      { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
    );

    expect(result).toEqual({ ok: true, probe: "status" });
  } finally {
    server.stop(true);
  }
});

test("postman collection specs load and execute request tools", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.startsWith("/items/")) {
        const id = url.pathname.split("/").filter(Boolean)[1] ?? "";
        return Response.json({
          ok: true,
          id,
          expand: url.searchParams.get("expand"),
          limit: url.searchParams.get("limit"),
          token: req.headers.get("x-token"),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const proxy = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { service?: string; method?: string; path?: string };
      if (body.service === "sync" && body.method === "GET" && body.path === "/collection/123-demo?populate=true") {
        return Response.json({
          data: {
            name: "Demo collection",
            variables: [{ key: "token", value: "Bearer demo-token" }],
            folders: [{ id: "folder_items", name: "Items" }],
            requests: [
              {
                id: "request_get_item",
                name: "Get item",
                method: "GET",
                url: `http://127.0.0.1:${upstream.port}/items/{{itemId}}`,
                folder: "folder_items",
                headerData: [{ key: "x-token", value: "{{token}}" }],
                queryParams: [{ key: "expand", value: "details" }],
                pathVariableData: [{ key: "itemId", value: "default-id" }],
              },
            ],
          },
        });
      }
      return Response.json({ error: "unknown request" }, { status: 400 });
    },
  });

  try {
    const { tools, warnings } = await loadExternalTools([
      {
        type: "openapi",
        name: "postman-demo",
        spec: "postman:123-demo",
        postmanProxyUrl: `http://127.0.0.1:${proxy.port}`,
      },
    ]);

    expect(warnings).toHaveLength(0);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.source).toBe("catalog:postman-demo");
    expect(tools[0]?.path).toContain("items");

    const result = await tools[0]!.run(
      {
        variables: { itemId: "abc-123" },
        query: { limit: 10 },
      },
      { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
    );

    expect(result).toEqual({
      ok: true,
      id: "abc-123",
      expand: "details",
      limit: "10",
      token: "Bearer demo-token",
    });
  } finally {
    proxy.stop(true);
    upstream.stop(true);
  }
});

test("postman collection supports v2 body modes", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/submit") {
        return Response.json({
          ok: true,
          body: await req.text(),
          contentType: req.headers.get("content-type"),
          token: req.headers.get("x-token"),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const proxy = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { service?: string; method?: string; path?: string };
      if (body.service === "sync" && body.method === "GET" && body.path === "/collection/123-v2-body?populate=true") {
        return Response.json({
          data: {
            name: "Demo v2 body collection",
            variables: [{ key: "token", value: "Bearer v2-token" }],
            requests: [
              {
                id: "request_submit",
                name: "Submit payload",
                method: "POST",
                url: `http://127.0.0.1:${upstream.port}/submit`,
                headerData: [{ key: "x-token", value: "{{token}}" }],
                body: {
                  mode: "urlencoded",
                  urlencoded: [
                    { key: "itemId", value: "{{itemId}}" },
                    { key: "count", value: 2 },
                  ],
                },
              },
            ],
          },
        });
      }
      return Response.json({ error: "unknown request" }, { status: 400 });
    },
  });

  try {
    const { tools, warnings } = await loadExternalTools([
      {
        type: "openapi",
        name: "postman-v2-body",
        spec: "postman:123-v2-body",
        postmanProxyUrl: `http://127.0.0.1:${proxy.port}`,
      },
    ]);

    expect(warnings).toHaveLength(0);
    expect(tools).toHaveLength(1);

    const result = await tools[0]!.run(
      {
        variables: { itemId: "xyz" },
      },
      { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
    );

    expect(result).toEqual({
      ok: true,
      body: "itemId=xyz&count=2",
      contentType: "application/x-www-form-urlencoded",
      token: "Bearer v2-token",
    });
  } finally {
    proxy.stop(true);
    upstream.stop(true);
  }
});

test("parseGraphqlOperationPaths handles aliases and fragments", async () => {
  const parsed = parseGraphqlOperationPaths(
    "linear",
    `
      query TeamsAndViewer {
        currentTeams: teams { nodes { id } }
        ...ViewerFields
      }

      fragment ViewerFields on Query {
        viewer { id }
      }
    `,
  );

  expect(parsed.operationType).toBe("query");
  expect(parsed.fieldPaths).toEqual([
    "linear.query.teams",
    "linear.query.viewer",
  ]);
});

test("parseGraphqlOperationPaths returns empty paths for invalid queries", async () => {
  const parsed = parseGraphqlOperationPaths("linear", "query { teams(");
  expect(parsed.operationType).toBe("query");
  expect(parsed.fieldPaths).toEqual([]);
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
                      description: "List teams",
                      isDeprecated: true,
                      deprecationReason: "Use organizations instead",
                      args: [
                        {
                          name: "first",
                          description: "Maximum teams to return",
                          defaultValue: "50",
                          isDeprecated: true,
                          deprecationReason: "Use pagination.limit instead",
                          type: { kind: "SCALAR", name: "Int", ofType: null },
                        },
                      ],
                      type: { kind: "OBJECT", name: "TeamConnection", ofType: null },
                    },
                    {
                      name: "search",
                      description: "Search for entities",
                      args: [],
                      type: { kind: "UNION", name: "SearchResult", ofType: null },
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
                          description: "Batch issue payload",
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
                      description: "Team display name",
                      isDeprecated: true,
                      deprecationReason: "Use displayName",
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
                  kind: "UNION",
                  name: "SearchResult",
                  fields: null,
                  inputFields: null,
                  enumValues: null,
                  possibleTypes: [
                    { kind: "OBJECT", name: "Team", ofType: null },
                    { kind: "OBJECT", name: "Issue", ofType: null },
                  ],
                },
                {
                  kind: "INPUT_OBJECT",
                  name: "IssueBatchCreateInput",
                  fields: null,
                  inputFields: [
                    {
                      name: "issues",
                      description: "Issue titles",
                      isDeprecated: true,
                      deprecationReason: "Use issueInputs instead",
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

      if (query.includes("search")) {
        if (!/search(?:\([^)]*\))?\s*\{/.test(query)) {
          return Response.json({ errors: [{ message: "search requires a selection set" }] });
        }
        return Response.json({
          data: {
            search: {
              __typename: "Team",
              id: "team_1",
              name: "Core",
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
    const searchTool = toolMap.get("linear.query.search");
    const batchTool = toolMap.get("linear.mutation.issuebatchcreate");
    const rawTool = toolMap.get("linear.graphql");

    expect(teamsTool).toBeDefined();
    expect(searchTool).toBeDefined();
    expect(batchTool).toBeDefined();
    expect(rawTool).toBeDefined();

    const teamsInputSchema = teamsTool!.typing?.inputSchema as {
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(teamsInputSchema.properties?.first?.description).toBe("Maximum teams to return");
    expect(teamsInputSchema.properties?.first?.default).toBe(50);
    expect(teamsInputSchema.properties?.first?.deprecated).toBe(true);
    expect(teamsInputSchema.properties?.first?.["x-deprecationReason"]).toBe("Use pagination.limit instead");

    const batchInputSchema = batchTool!.typing?.inputSchema as {
      properties?: Record<string, { description?: string; properties?: Record<string, Record<string, unknown>> }>;
    };
    expect(batchInputSchema.properties?.input?.description).toBe("Batch issue payload");
    expect(batchInputSchema.properties?.input?.properties?.issues?.description).toBe("Issue titles");
    expect(batchInputSchema.properties?.input?.properties?.issues?.deprecated).toBe(true);

    const searchOutputSchema = searchTool!.typing?.outputSchema as {
      properties?: Record<string, { oneOf?: unknown[] }>;
    };
    expect(Array.isArray(searchOutputSchema.properties?.data?.oneOf)).toBe(true);
    expect((searchOutputSchema.properties?.data?.oneOf ?? []).length).toBeGreaterThan(1);

    const teamsOutputSchema = teamsTool!.typing?.outputSchema as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(teamsOutputSchema.properties?.data?.properties).toBeDefined();
    expect(Object.keys(teamsOutputSchema.properties?.data?.properties ?? {})).toContain("totalCount");

    const context = { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true };

    const teamsResult = await teamsTool!.run({}, context);
    const searchResult = await searchTool!.run({}, context);
    const batchResult = await batchTool!.run({ input: { issues: ["one"] } }, context);
    const batchResultDoubleWrapped = await batchTool!.run({ input: { input: { issues: ["two"] } } }, context);
    const rawResult = await rawTool!.run({ query: "query { teams { totalCount } }" }, context);
    const rawStringResult = await rawTool!.run("query { teams { totalCount } }", context);

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
    expect(searchResult).toEqual({
      data: {
        __typename: "Team",
        id: "team_1",
        name: "Core",
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
    expect(rawStringResult).toEqual({
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
    expect(helperQueries.some((query) => /search(?:\([^)]*\))?\s*\{/.test(query))).toBe(true);
    expect(helperQueries.some((query) => /issueBatchCreate(?:\([^)]*\))?\s*\{/.test(query))).toBe(true);
    expect(helperQueries.some((query) => /teams(?:\([^)]*\))?\s*\{[^}]*nodes\s*\{/.test(query))).toBe(true);
    expect(helperQueries.some((query) => /issueBatchCreate(?:\([^)]*\))?\s*\{[^}]*issues\s*\{/.test(query))).toBe(true);
    expect(helperVariables.some((variables) => JSON.stringify(variables) === JSON.stringify({ input: { issues: ["one"] } }))).toBe(true);
    expect(helperVariables.some((variables) => JSON.stringify(variables) === JSON.stringify({ input: { issues: ["two"] } }))).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("graphql loader fails fast when server rejects extended introspection", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { query?: string };
      const query = String(body.query ?? "");

      if (query.includes("__schema")) {
        return Response.json({
          errors: [{ message: "Unknown argument 'includeDeprecated'" }],
        });
      }

      if (query.includes("ping")) {
        return Response.json({
          data: { ping: "pong" },
        });
      }

      return Response.json({ errors: [{ message: "Unknown operation" }] });
    },
  });

  try {
    const { tools, warnings } = await loadExternalTools([
      {
        type: "graphql",
        name: "legacy",
        endpoint: `http://127.0.0.1:${server.port}/graphql`,
      },
    ]);

    expect(tools).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("legacy");
    expect(warnings[0]).toContain("includeDeprecated");
  } finally {
    server.stop(true);
  }
});

test("openapi fallback type hints include index signature when truncated", async () => {
  const manyProps = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`field_${i}`, { type: "string" }]),
  );

  const { tools, warnings } = await loadExternalTools([
    {
      type: "openapi",
      name: "wide",
      baseUrl: "https://example.com",
      spec: {
        openapi: "3.0.3",
        info: { title: "Wide", version: "1.0.0" },
        paths: {
          "/items": {
            get: {
              operationId: "getItems",
              tags: ["items"],
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: manyProps,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  ]);

  expect(warnings).toHaveLength(0);
  const getItems = tools.find((tool) => tool.path === "wide.items.get_items");
  expect(getItems).toBeDefined();
  const outputSchema = getItems?.typing?.outputSchema as Record<string, unknown> | undefined;
  expect(outputSchema).toBeDefined();
  const props = outputSchema && typeof outputSchema === "object" ? (outputSchema.properties as Record<string, unknown> | undefined) : undefined;
  expect(Object.keys(props ?? {}).length).toBeGreaterThan(12);
});

test("graphql helper tools inherit credential spec from source auth", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { query?: string };
      const query = String(body.query ?? "");

      if (query.includes("__schema")) {
        return Response.json({
          data: {
            __schema: {
              queryType: { name: "Query" },
              mutationType: null,
              types: [
                {
                  kind: "OBJECT",
                  name: "Query",
                  fields: [
                    {
                      name: "teams",
                      description: null,
                      args: [],
                      type: { kind: "SCALAR", name: "String", ofType: null },
                    },
                  ],
                  inputFields: null,
                  enumValues: null,
                },
                {
                  kind: "SCALAR",
                  name: "String",
                  fields: null,
                  inputFields: null,
                  enumValues: null,
                },
              ],
            },
          },
        });
      }

      return Response.json({ data: { teams: "ok" } });
    },
  });

  try {
    const { tools, warnings } = await loadExternalTools([
      {
        type: "graphql",
        name: "linear",
        sourceKey: "source:stable-linear-id",
        endpoint: `http://127.0.0.1:${server.port}/graphql`,
        auth: {
          type: "bearer",
          mode: "account",
        },
      },
    ]);

    expect(warnings).toHaveLength(0);

    const rawTool = tools.find((tool) => tool.path === "linear.graphql");
    const helperTool = tools.find((tool) => tool.path === "linear.query.teams");

    expect(rawTool?.credential).toEqual({
      sourceKey: "source:stable-linear-id",
      mode: "account",
      authType: "bearer",
    });
    expect(helperTool?.credential).toEqual({
      sourceKey: "source:stable-linear-id",
      mode: "account",
      authType: "bearer",
    });
  } finally {
    server.stop(true);
  }
});
