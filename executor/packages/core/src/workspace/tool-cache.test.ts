/**
 * Tests for workspace tool cache serialization and rehydration.
 *
 * Verifies that tools survive the serialize → JSON → deserialize → rehydrate
 * round-trip with functional `run` methods.
 */
import { test, expect, describe } from "bun:test";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  prepareOpenApiSpec,
  buildOpenApiToolsFromPrepared,
  materializeWorkspaceSnapshot,
  serializeTools,
  rehydrateTools,
  type CompiledToolSourceArtifact,
  type SerializedTool,
  type WorkspaceToolSnapshot,
} from "../tool-sources";
import type { ToolDefinition } from "../types";

const TEST_WORKSPACE_ID = "w" as Id<"workspaces">;

function makeBaseTools(): Map<string, ToolDefinition> {
  return new Map([
    [
      "echo",
      {
        path: "echo",
        description: "Echo input",
        approval: "auto" as const,
        source: "system",
        typing: {
          inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          outputSchema: { type: "string" },
          requiredInputKeys: ["message"],
          previewInputKeys: ["message"],
        },
        run: async (input: unknown) => {
          const payload = input as Record<string, unknown>;
          return payload.message;
        },
      },
    ],
  ]);
}

const SMALL_SPEC: Record<string, unknown> = {
  openapi: "3.0.3",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  components: {
    schemas: {
      Widget: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          status: { type: "string", enum: ["active", "inactive"] },
        },
        required: ["id", "name"],
      },
    },
  },
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        tags: ["widgets"],
        summary: "List widgets",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "inactive"] } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Widget" } },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createWidget",
        tags: ["widgets"],
        summary: "Create a widget",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  status: { type: "string", enum: ["active", "inactive"] },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Widget" },
              },
            },
          },
        },
      },
    },
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        tags: ["widgets"],
        summary: "Get a widget",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Widget" },
              },
            },
          },
        },
      },
      delete: {
        operationId: "deleteWidget",
        tags: ["widgets"],
        summary: "Delete a widget",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": { description: "deleted" },
        },
      },
    },
  },
};

describe("serializeTools + rehydrateTools round-trip", () => {
  test("OpenAPI tools survive serialization round-trip", async () => {
    const prepared = await prepareOpenApiSpec(SMALL_SPEC, "test-api");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "test-api",
        spec: SMALL_SPEC,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    expect(tools.length).toBe(4);

    // Serialize
    const serialized = serializeTools(tools);
    expect(serialized.length).toBe(4);

    // Every tool should have a runSpec
    for (const st of serialized) {
      expect(st.runSpec.kind).toBe("openapi");
      if (st.runSpec.kind === "openapi") {
        expect(st.runSpec.baseUrl).toBe("https://api.example.com");
        expect(typeof st.runSpec.method).toBe("string");
        expect(typeof st.runSpec.pathTemplate).toBe("string");
      }
    }

    // JSON round-trip (simulates storage)
    const json = JSON.stringify(serialized);
    const restored = JSON.parse(json) as SerializedTool[];
    expect(restored.length).toBe(4);

    // Rehydrate
    const rehydrated = rehydrateTools(restored, makeBaseTools());
    expect(rehydrated.length).toBe(4);

    // Every rehydrated tool should have a working run function
    for (const tool of rehydrated) {
      expect(typeof tool.run).toBe("function");
      expect(tool.path).toContain("test_api.");
      expect(tool.typing).toBeDefined();
      expect(tool.typing!.inputSchema).toBeDefined();
    }
  });

  test("preserves tool descriptors exactly", async () => {
    const prepared = await prepareOpenApiSpec(SMALL_SPEC, "test-api");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "test-api",
        spec: SMALL_SPEC,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const serialized = serializeTools(tools);
    const json = JSON.stringify(serialized);
    const restored = JSON.parse(json) as SerializedTool[];
    const rehydrated = rehydrateTools(restored, makeBaseTools());

    for (let i = 0; i < tools.length; i++) {
      expect(rehydrated[i]!.path).toBe(tools[i]!.path);
      expect(rehydrated[i]!.description).toBe(tools[i]!.description);
      expect(rehydrated[i]!.approval).toBe(tools[i]!.approval);
      expect(rehydrated[i]!.source).toBe(tools[i]!.source);
      expect(rehydrated[i]!.typing?.typedRef?.operationId).toBe(tools[i]!.typing?.typedRef?.operationId);
      expect(rehydrated[i]!.typing?.requiredInputKeys).toEqual(tools[i]!.typing?.requiredInputKeys);
    }
  });

  test("builtin tools rehydrate from baseTools map", async () => {
    const baseTools = makeBaseTools();
    const echo = baseTools.get("echo")!;

    const serialized = serializeTools([echo]);
    expect(serialized[0]!.runSpec.kind).toBe("builtin");

    const json = JSON.stringify(serialized);
    const restored = JSON.parse(json) as SerializedTool[];
    const rehydrated = rehydrateTools(restored, baseTools);

    expect(rehydrated.length).toBe(1);
    expect(rehydrated[0]!.path).toBe("echo");

    // The rehydrated run should work
    const result = await rehydrated[0]!.run(
      { message: "hello" },
      { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
    );
    expect(result).toBe("hello");
  });

  test("MCP tools get serializable runSpec", () => {
    const mcpTool: ToolDefinition = {
      path: "my_mcp.some_tool",
      description: "An MCP tool",
      approval: "auto",
      source: "mcp:my_mcp",
      typing: {
        inputSchema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
        requiredInputKeys: ["input"],
        previewInputKeys: ["input"],
      },
      _runSpec: {
        kind: "mcp" as const,
        url: "https://mcp.example.com/sse",
        transport: "sse" as const,
        authHeaders: {},
        toolName: "some_tool",
      },
      run: async () => "mock",
    };

    const serialized = serializeTools([mcpTool]);
    expect(serialized[0]!.runSpec.kind).toBe("mcp");
    if (serialized[0]!.runSpec.kind === "mcp") {
      expect(serialized[0]!.runSpec.url).toBe("https://mcp.example.com/sse");
      expect(serialized[0]!.runSpec.toolName).toBe("some_tool");
    }

    // JSON round-trip
    const json = JSON.stringify(serialized);
    const restored = JSON.parse(json) as SerializedTool[];
    expect(restored[0]!.runSpec.kind).toBe("mcp");
  });

  test("GraphQL raw and field tools survive cache round-trip", async () => {
    const graphqlTools: ToolDefinition[] = [
      {
        path: "linear.graphql",
        description: "Execute GraphQL",
        approval: "auto",
        source: "graphql:linear",
        typing: {
          inputSchema: { type: "object", properties: { query: { type: "string" }, variables: {} }, required: ["query"] },
          requiredInputKeys: ["query"],
          previewInputKeys: ["query", "variables"],
        },
        _runSpec: {
          kind: "graphql_raw" as const,
          endpoint: "https://linear.example/graphql",
          authHeaders: {},
        },
        run: async () => ({ ok: true }),
      },
      {
        path: "linear.query.teams",
        description: "List teams",
        approval: "auto",
        source: "graphql:linear",
        typing: {
          inputSchema: { type: "object", properties: {} },
        },
        _pseudoTool: true,
        _runSpec: {
          kind: "graphql_field" as const,
          endpoint: "https://linear.example/graphql",
          operationName: "teams",
          operationType: "query" as const,
          queryTemplate: "query teams { teams { nodes { id name } } }",
          authHeaders: {},
        },
        run: async () => ({ ok: true }),
      },
    ];

    const serialized = serializeTools(graphqlTools);
    expect(serialized[0]!.runSpec.kind).toBe("graphql_raw");
    expect(serialized[1]!.runSpec.kind).toBe("graphql_field");

    const restored = JSON.parse(JSON.stringify(serialized)) as SerializedTool[];
    const rehydrated = rehydrateTools(restored, makeBaseTools());

    const rawTool = rehydrated.find((tool) => tool.path === "linear.graphql");
    const teamsTool = rehydrated.find((tool) => tool.path === "linear.query.teams");
    expect(rawTool).toBeDefined();
    expect(teamsTool).toBeDefined();

    const originalFetch = globalThis.fetch;
    const calls: Array<{ query: string; variables: unknown }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: unknown };
      calls.push({ query: body.query ?? "", variables: body.variables });

      if ((body.query ?? "").includes("teams")) {
        return new Response(JSON.stringify({ data: { teams: [{ id: "team_1", name: "Core" }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ data: { viewer: { id: "user_1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const rawResult = await rawTool!.run(
        { query: "query viewer { viewer { id } }" },
        { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
      );
      const teamsResult = await teamsTool!.run(
        {},
        { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
      );

      expect(rawResult).toEqual({ data: { viewer: { id: "user_1" } }, errors: [] });
      expect(teamsResult).toEqual({ data: [{ id: "team_1", name: "Core" }], errors: [] });
      expect(calls.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("WorkspaceToolSnapshot v2 round-trip", async () => {
    const prepared = await prepareOpenApiSpec(SMALL_SPEC, "widgets");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "widgets",
        spec: SMALL_SPEC,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const artifact: CompiledToolSourceArtifact = {
      version: "v1",
      sourceType: "openapi",
      sourceName: "widgets",
      tools: serializeTools(tools),
    };

    const snapshot: WorkspaceToolSnapshot = {
      version: "v2",
      externalArtifacts: [artifact],
      warnings: ["test warning"],
    };

    // Simulate storage: serialize → blob → read → deserialize
    const json = JSON.stringify(snapshot);
    const blob = new Blob([json], { type: "application/json" });
    const text = await blob.text();
    const restored = JSON.parse(text) as WorkspaceToolSnapshot;

    expect(restored.warnings).toEqual(["test warning"]);
    expect(restored.version).toBe("v2");
    expect(restored.externalArtifacts).toHaveLength(1);

    const restoredTools = materializeWorkspaceSnapshot(restored);
    expect(restoredTools.length).toBe(tools.length);
    expect(restoredTools.some((tool) => tool.path === "echo")).toBe(false);

    // OpenAPI tools should have correct metadata
    const listTool = restoredTools.find((t) => t.typing?.typedRef?.operationId === "listWidgets")!;
    expect(listTool.approval).toBe("auto"); // GET = auto
    expect(listTool.typing!.inputSchema).toBeDefined();

    const createTool = restoredTools.find((t) => t.typing?.typedRef?.operationId === "createWidget")!;
    expect(createTool.approval).toBe("required"); // POST = required
  });

  test("snapshot size is reasonable", async () => {
    // Build tools from a spec with many operations
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      paths[`/resource_${i}`] = {
        get: {
          operationId: `getResource${i}`,
          tags: [`resource_${i}`],
          summary: `Get resource ${i}`,
          parameters: [
            { name: "id", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" }, name: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      };
    }

    const spec = {
      openapi: "3.0.3",
      info: { title: "Big API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths,
    };

    const prepared = await prepareOpenApiSpec(spec, "big-api");
    const tools = buildOpenApiToolsFromPrepared(
      { type: "openapi", name: "big-api", spec, baseUrl: "https://api.example.com" },
      prepared,
    );

    const artifact: CompiledToolSourceArtifact = {
      version: "v1",
      sourceType: "openapi",
      sourceName: "big-api",
      tools: serializeTools(tools),
    };

    const snapshot: WorkspaceToolSnapshot = {
      version: "v2",
      externalArtifacts: [artifact],
      warnings: [],
    };

    const json = JSON.stringify(snapshot);
    const sizeKB = json.length / 1024;
    console.log(`100-tool snapshot: ${sizeKB.toFixed(0)}KB`);

    // Should be well under 1MB for 100 tools
    expect(json.length).toBeLessThan(1_000_000);
  });
});

describe("workspace tool cache table", () => {
  async function setupCacheTest() {
    const { convexTest } = await import("convex-test");
    const { internal } = await import("../../../convex/_generated/api");
    const schema = (await import("../../../convex/schema")).default;

    const t = convexTest(schema, {
      "./workspaceToolCache.ts": () => import("../../../convex/workspaceToolCache"),
      "./_generated/api.js": () => import("../../../convex/_generated/api.js"),
    });

    const wsId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        name: "test-org",
        slug: "test-org",
        status: "active" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("workspaces", {
        name: "test-ws",
        slug: "test-ws",
        organizationId: orgId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    return { t, internal, wsId };
  }

  test("getEntry + putEntry round-trip", async () => {
    const { t, internal, wsId } = await setupCacheTest();

    // Empty cache
    const miss = await t.query(internal.workspaceToolCache.getEntry, {
      workspaceId: wsId,
      signature: "sig_1",
    });
    expect(miss).toBeNull();

    // Store
    const storageId = await t.run(async (ctx) => {
      const blob = new Blob(['{"tools":[],"warnings":[]}'], { type: "application/json" });
      return await ctx.storage.store(blob);
    });

    await t.mutation(internal.workspaceToolCache.putEntry, {
      workspaceId: wsId,
      signature: "sig_1",
      storageId,
      toolCount: 0,
      sizeBytes: 27,
    });

    // Hit
    const hit = await t.query(internal.workspaceToolCache.getEntry, {
      workspaceId: wsId,
      signature: "sig_1",
    });
    expect(hit).not.toBeNull();
    expect(hit!.storageId).toBe(storageId);

    // Wrong signature = stale entry
    const wrongSig = await t.query(internal.workspaceToolCache.getEntry, {
      workspaceId: wsId,
      signature: "sig_2",
    });
    expect(wrongSig).not.toBeNull();
    expect(wrongSig!.isFresh).toBe(false);
    expect(wrongSig!.storageId).toBe(storageId);
  });

  test("putEntry replaces old entry and deletes old blob", async () => {
    const { t, internal, wsId } = await setupCacheTest();

    const storageId1 = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["old"]));
    });

    await t.mutation(internal.workspaceToolCache.putEntry, {
      workspaceId: wsId,
      signature: "sig_1",
      storageId: storageId1,
      toolCount: 5,
      sizeBytes: 3,
    });

    const storageId2 = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["new"]));
    });

    await t.mutation(internal.workspaceToolCache.putEntry, {
      workspaceId: wsId,
      signature: "sig_2",
      storageId: storageId2,
      toolCount: 10,
      sizeBytes: 3,
    });

    // New entry
    const entry = await t.query(internal.workspaceToolCache.getEntry, {
      workspaceId: wsId,
      signature: "sig_2",
    });
    expect(entry!.storageId).toBe(storageId2);
    expect(entry!.toolCount).toBe(10);

    // Old blob deleted
    const oldBlob = await t.run(async (ctx) => ctx.storage.get(storageId1));
    expect(oldBlob).toBeNull();
  });
});
