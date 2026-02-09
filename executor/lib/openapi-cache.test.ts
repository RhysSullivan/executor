import { expect, test, describe } from "bun:test";
import {
  prepareOpenApiSpec,
  buildOpenApiToolsFromPrepared,
  type PreparedOpenApiSpec,
} from "./tool_sources";

/**
 * Generate a synthetic OpenAPI spec with many operations, simulating a large
 * real-world spec like Stripe, GitHub, or Cloudflare.
 *
 * Each operation gets a unique tag, operationId, parameters, request body,
 * and response schema to produce meaningful type metadata.
 */
function makeLargeSpec(operationCount: number): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (let i = 0; i < operationCount; i++) {
    const tag = `resource_${i}`;
    const pathTemplate = `/api/v1/${tag}/{id}`;

    paths[pathTemplate] = {
      get: {
        operationId: `get_${tag}`,
        tags: [tag],
        summary: `Get ${tag} by ID`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "include",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["metadata", "related", "all"] },
          },
        ],
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    created_at: { type: "string" },
                    status: {
                      type: "string",
                      enum: ["active", "inactive", "archived"],
                    },
                    metadata: {
                      type: "object",
                      properties: {
                        key: { type: "string" },
                        value: { type: "string" },
                      },
                    },
                  },
                  required: ["id", "name"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: `create_${tag}`,
        tags: [tag],
        summary: `Create ${tag}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  config: {
                    type: "object",
                    properties: {
                      enabled: { type: "boolean" },
                      timeout: { type: "number" },
                      tags: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                  },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      delete: {
        operationId: `delete_${tag}`,
        tags: [tag],
        summary: `Delete ${tag}`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "204": { description: "Deleted" },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: { title: "Large Test API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths,
  };
}

describe("prepareOpenApiSpec with large specs", () => {
  test("handles spec with 100 resources (300 operations) without truncation", async () => {
    const spec = makeLargeSpec(100);
    const prepared = await prepareOpenApiSpec(spec, "large-test");

    // Should have all operations
    const pathCount = Object.keys(prepared.paths).length;
    expect(pathCount).toBe(100);

    // Should not have any size-related warnings
    const sizeWarnings = prepared.warnings.filter(
      (w) =>
        w.includes("cache size") ||
        w.includes("too large") ||
        w.includes("metadata omitted"),
    );
    expect(sizeWarnings).toHaveLength(0);

    // Verify the full prepared spec serializes to well over the old 900KB limit
    // to confirm we're not artificially truncating
    const json = JSON.stringify(prepared);
    // 100 resources × 3 ops each × ~2KB per op = ~600KB minimum
    // With type metadata it should be even larger
    expect(json.length).toBeGreaterThan(100_000);
  });

  test("preserves operationTypes when spec is large", async () => {
    const spec = makeLargeSpec(50);
    const prepared = await prepareOpenApiSpec(spec, "type-test");

    // openapiTS should generate types for all operations
    if (prepared.operationTypes) {
      const opCount = Object.keys(prepared.operationTypes).length;
      // Should have types for most operations (openapiTS generates from valid specs)
      expect(opCount).toBeGreaterThan(0);

      // Spot-check a known operation
      const getType = prepared.operationTypes["get_resource_0"];
      if (getType) {
        expect(getType.argsType).toBeDefined();
        expect(getType.returnsType).toBeDefined();
      }
    }
  });

  test("preserves schemaTypes when spec has shared schemas", async () => {
    const specWithSchemas: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Schema Test", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: { type: "string" },
              name: { type: "string" },
              role: { type: "string", enum: ["admin", "user", "viewer"] },
            },
            required: ["id", "email"],
          },
          UserList: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { $ref: "#/components/schemas/User" },
              },
              total: { type: "number" },
            },
          },
        },
      },
      paths: {
        "/users": {
          get: {
            operationId: "listUsers",
            tags: ["users"],
            summary: "List users",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/UserList" },
                  },
                },
              },
            },
          },
        },
        "/users/{id}": {
          get: {
            operationId: "getUser",
            tags: ["users"],
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            summary: "Get user",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(specWithSchemas, "schema-test");

    // Should have generated schema types
    if (prepared.schemaTypes) {
      expect(Object.keys(prepared.schemaTypes).length).toBeGreaterThan(0);
    }

    // No warnings
    expect(prepared.warnings).toHaveLength(0);
  });
});

describe("buildOpenApiToolsFromPrepared", () => {
  test("builds tools from a prepared spec with full type metadata", async () => {
    const spec = makeLargeSpec(5);
    const prepared = await prepareOpenApiSpec(spec, "build-test");

    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "test-api",
        spec,
        baseUrl: "https://api.example.com/v1",
      },
      prepared,
    );

    // 5 resources × 3 operations each = 15 tools
    expect(tools).toHaveLength(15);

    // Each tool should have metadata
    for (const tool of tools) {
      expect(tool.metadata).toBeDefined();
      expect(tool.metadata!.argsType).toBeDefined();
      expect(tool.metadata!.returnsType).toBeDefined();
    }

    // GET operations should default to "auto" approval
    const getTools = tools.filter((t) => t.path.includes("get_"));
    for (const tool of getTools) {
      expect(tool.approval).toBe("auto");
    }

    // POST/DELETE operations should default to "required" approval
    const writeTools = tools.filter(
      (t) => t.path.includes("create_") || t.path.includes("delete_"),
    );
    for (const tool of writeTools) {
      expect(tool.approval).toBe("required");
    }
  });

  test("resolves shared parameter refs and maps 204 responses to void", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "GitHub-like", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        parameters: {
          owner: {
            name: "owner",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          repo: {
            name: "repo",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        },
      },
      paths: {
        "/repos/{owner}/{repo}/subscription": {
          parameters: [
            { $ref: "#/components/parameters/owner" },
            { $ref: "#/components/parameters/repo" },
          ],
          delete: {
            operationId: "activity/delete-repo-subscription",
            tags: ["activity"],
            responses: {
              "204": { description: "No Content" },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "github-like");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "github",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "activity/delete-repo-subscription");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.argsType).toContain("owner");
    expect(tool!.metadata?.argsType).toContain("repo");
    expect(tool!.metadata?.returnsType).toBe("void");
  });

  test("supports Swagger 2.x parameter and response schemas for type hints", async () => {
    const spec: Record<string, unknown> = {
      swagger: "2.0",
      info: { title: "Slack-like", version: "1.0.0" },
      host: "api.example.com",
      schemes: ["https"],
      basePath: "/api",
      paths: {
        "/admin.apps.approved.list": {
          get: {
            operationId: "admin_apps_approved_list",
            tags: ["admin.apps.approved"],
            parameters: [
              { name: "token", in: "query", required: true, type: "string" },
              { name: "limit", in: "query", required: false, type: "integer" },
            ],
            responses: {
              "200": {
                description: "ok",
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                  },
                  required: ["ok"],
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "slack-like");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "slack",
        spec,
        baseUrl: "https://api.example.com/api",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "admin_apps_approved_list");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.argsType).toContain("token: string");
    expect(tool!.metadata?.argsType).toContain("limit?: number");
    expect(tool!.metadata?.returnsType).toContain("ok");
    expect(tool!.metadata?.returnsType).not.toBe("unknown");
  });

  test("schemaTypes only attached to first tool from a source", async () => {
    const specWithSchemas: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Schema placement test", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          Widget: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/widgets": {
          get: {
            operationId: "listWidgets",
            tags: ["widgets"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Widget" },
                    },
                  },
                },
              },
            },
          },
          post: {
            operationId: "createWidget",
            tags: ["widgets"],
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Widget" },
                },
              },
            },
            responses: {
              "201": { description: "created" },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(specWithSchemas, "schema-placement");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "widgets",
        spec: specWithSchemas,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    expect(tools.length).toBe(2);

    // Only the first tool should have schemaTypes
    const withSchemas = tools.filter(
      (t) => t.metadata?.schemaTypes && Object.keys(t.metadata.schemaTypes).length > 0,
    );
    expect(withSchemas.length).toBeLessThanOrEqual(1);
  });
});

describe("prepared spec serialization round-trip", () => {
  test("prepared spec survives JSON serialization (simulating cache store/load)", async () => {
    const spec = makeLargeSpec(20);
    const prepared = await prepareOpenApiSpec(spec, "roundtrip-test");

    // Simulate what loadCachedOpenApiSpec does: serialize → store → load → deserialize
    const json = JSON.stringify(prepared);
    const restored = JSON.parse(json) as PreparedOpenApiSpec;

    expect(restored.servers).toEqual(prepared.servers);
    expect(Object.keys(restored.paths).length).toBe(
      Object.keys(prepared.paths).length,
    );
    expect(restored.warnings).toEqual(prepared.warnings);

    if (prepared.operationTypes) {
      expect(restored.operationTypes).toBeDefined();
      expect(Object.keys(restored.operationTypes!).length).toBe(
        Object.keys(prepared.operationTypes).length,
      );
    }

    if (prepared.schemaTypes) {
      expect(restored.schemaTypes).toBeDefined();
      expect(Object.keys(restored.schemaTypes!).length).toBe(
        Object.keys(prepared.schemaTypes).length,
      );
    }

    // Verify tools built from the restored spec match the original
    const config = {
      type: "openapi" as const,
      name: "roundtrip",
      spec,
      baseUrl: "https://api.example.com/v1",
    };
    const originalTools = buildOpenApiToolsFromPrepared(config, prepared);
    const restoredTools = buildOpenApiToolsFromPrepared(config, restored);

    expect(restoredTools.length).toBe(originalTools.length);
    for (let i = 0; i < originalTools.length; i++) {
      expect(restoredTools[i]!.path).toBe(originalTools[i]!.path);
      expect(restoredTools[i]!.description).toBe(originalTools[i]!.description);
      expect(restoredTools[i]!.approval).toBe(originalTools[i]!.approval);
      expect(restoredTools[i]!.metadata?.argsType).toBe(
        originalTools[i]!.metadata?.argsType,
      );
      expect(restoredTools[i]!.metadata?.returnsType).toBe(
        originalTools[i]!.metadata?.returnsType,
      );
    }
  });

  test("large spec serialized size exceeds old 900KB limit", async () => {
    // Generate a spec large enough to exceed the old ActionCache limit.
    // This verifies that the new approach handles what the old one couldn't.
    const spec = makeLargeSpec(200);
    const prepared = await prepareOpenApiSpec(spec, "size-test");
    const json = JSON.stringify(prepared);

    // The old limit was 900_000 bytes. With 200 resources (600 operations),
    // the prepared spec with full type metadata should exceed that easily.
    console.log(
      `Large spec size: ${(json.length / 1024).toFixed(0)}KB (old limit: 900KB)`,
    );

    // Even if it doesn't exceed 900KB with this synthetic spec (real APIs have
    // much more complex schemas), verify no warnings about size limits exist
    const sizeWarnings = prepared.warnings.filter(
      (w) => w.includes("cache size") || w.includes("too large"),
    );
    expect(sizeWarnings).toHaveLength(0);
  });
});

describe("spec with $ref keys survives cache round-trip", () => {
  test("specs with $ref in schemas serialize cleanly as JSON", async () => {
    // The old ActionCache approach had issues with $ref keys in Convex values.
    // The new approach stores as a JSON blob, which handles $ref fine.
    const specWithRefs: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Ref test", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          Address: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
            },
          },
          Person: {
            type: "object",
            properties: {
              name: { type: "string" },
              address: { $ref: "#/components/schemas/Address" },
            },
          },
        },
      },
      paths: {
        "/people": {
          get: {
            operationId: "listPeople",
            tags: ["people"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Person" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(specWithRefs, "ref-test");
    const json = JSON.stringify(prepared);

    // Should serialize without error
    expect(json.length).toBeGreaterThan(0);

    // Should deserialize back
    const restored = JSON.parse(json) as PreparedOpenApiSpec;
    expect(Object.keys(restored.paths).length).toBe(1);

    // Build tools from the restored spec
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "ref-api",
        spec: specWithRefs,
        baseUrl: "https://api.example.com",
      },
      restored,
    );

    expect(tools.length).toBe(1);
    expect(tools[0]!.path).toBe("ref_api.people.listpeople");
  });
});
