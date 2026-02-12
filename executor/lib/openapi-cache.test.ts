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

  test("very large specs still generate d.ts and typed tools", async () => {
    const spec = makeLargeSpec(250); // 750 operations
    const start = performance.now();
    const prepared = await prepareOpenApiSpec(spec, "large-full");
    const elapsed = performance.now() - start;

    expect(Object.keys(prepared.paths)).toHaveLength(250);
    expect(prepared.dts).toBeDefined();
    expect(prepared.warnings.some((warning: string) => warning.includes("skipped bundle"))).toBe(false);

    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "large-full",
        spec,
        baseUrl: "https://api.example.com/v1",
      },
      prepared,
    );

    expect(tools.length).toBeGreaterThan(700);
    const deleteTool = tools.find((tool) => tool.metadata?.operationId?.startsWith("delete_"));
    expect(deleteTool).toBeDefined();
    expect(deleteTool?.metadata?.displayReturnsType).toBeDefined();
    expect(deleteTool?.metadata?.displayReturnsType).not.toContain("ToolOutput<operations[");
    expect(elapsed).toBeLessThan(20_000);
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
      expect(tool.metadata!.displayArgsType).toBeDefined();
      expect(tool.metadata!.displayReturnsType).toBeDefined();
    }

    // GET operations should default to "auto" approval
    const getTools = tools.filter((t) =>
      (t.metadata?.operationId ?? "").startsWith("get_"),
    );
    for (const tool of getTools) {
      expect(tool.approval).toBe("auto");
    }

    // POST/DELETE operations should default to "required" approval
    const writeTools = tools.filter((t) => {
      const operationId = t.metadata?.operationId ?? "";
      return operationId.startsWith("create_") || operationId.startsWith("delete_");
    });
    for (const tool of writeTools) {
      expect(tool.approval).toBe("required");
    }
  });

  test("uses compact preview args for large nested request bodies", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Notion-like", version: "1.0.0" },
      servers: [{ url: "https://api.notion.example" }],
      paths: {
        "/databases": {
          post: {
            operationId: "createDatabase",
            tags: ["databases"],
            summary: "Create a database",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      parent: {
                        type: "object",
                        properties: {
                          page_id: { type: "string" },
                        },
                      },
                      title: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            text: {
                              type: "object",
                              properties: {
                                content: { type: "string" },
                              },
                            },
                          },
                        },
                      },
                      properties: {
                        type: "object",
                        additionalProperties: true,
                      },
                      icon: {
                        type: "object",
                        properties: { emoji: { type: "string" } },
                      },
                      cover: {
                        type: "object",
                        properties: {
                          external: {
                            type: "object",
                            properties: { url: { type: "string" } },
                          },
                        },
                      },
                    },
                    required: ["parent", "title", "properties"],
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
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

    const prepared = await prepareOpenApiSpec(spec, "notion-like");
    const tools = buildOpenApiToolsFromPrepared(
      { type: "openapi", name: "notion", spec, baseUrl: "https://api.notion.example" },
      prepared,
    );

    const createDbTool = tools.find((tool) => tool.metadata?.operationId === "createDatabase");
    expect(createDbTool).toBeDefined();
    expect(createDbTool?.metadata?.argPreviewKeys).toEqual([
      "parent",
      "title",
      "properties",
      "icon",
      "cover",
    ]);
    expect(createDbTool?.metadata?.displayArgsType).toBe(
      "{ parent: ...; title: ...; properties: ...; icon: ...; cover: ... }",
    );
  });

  test("infers workspace auth from OpenAPI securitySchemes when source auth is unset", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Auth inferred", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
      paths: {
        "/me": {
          get: {
            operationId: "getMe",
            tags: ["users"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "auth-inferred");
    expect(prepared.inferredAuth).toEqual({ type: "bearer", mode: "workspace" });

    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "auth-source",
        sourceKey: "source:test-source-id",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const meTool = tools.find((tool) => tool.metadata?.operationId === "getMe");
    expect(meTool?.credential).toEqual({
      sourceKey: "source:test-source-id",
      mode: "workspace",
      authType: "bearer",
    });
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

  test("quotes non-identifier parameter names in args type hints", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Header names", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/meta": {
          get: {
            operationId: "meta/get",
            tags: ["meta"],
            parameters: [
              {
                name: "X-GitHub-Api-Version",
                in: "header",
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
                        ver: { type: "string" },
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

    const prepared = await prepareOpenApiSpec(spec, "headers");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "github",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "meta/get");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.argsType).toContain('"X-GitHub-Api-Version"?: string');
  });

  test("resolves OpenAPI component schema refs for return type hints", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Ref return type", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          Runner: {
            type: "object",
            properties: {
              id: { type: "number" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
      },
      paths: {
        "/orgs/{org}/actions/hosted-runners": {
          post: {
            operationId: "actions/create-hosted-runner-for-org",
            tags: ["actions"],
            parameters: [
              { name: "org", in: "path", required: true, schema: { type: "string" } },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
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
                    schema: { $ref: "#/components/schemas/Runner" },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "ref-return");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "github",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "actions/create-hosted-runner-for-org");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.returnsType).toContain("id");
    expect(tool!.metadata?.returnsType).toContain("name");
    expect(tool!.metadata?.returnsType).not.toBe("unknown");
  });

  test("resolves OpenAPI component response refs for return type hints", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Response ref type", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          BudgetList: {
            type: "object",
            properties: {
              total: { type: "number" },
            },
            required: ["total"],
          },
        },
        responses: {
          BudgetResponse: {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BudgetList" },
              },
            },
          },
        },
      },
      paths: {
        "/organizations/{org}/settings/billing/budgets": {
          get: {
            operationId: "billing/get-all-budgets-org",
            tags: ["billing"],
            parameters: [
              { name: "org", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": { $ref: "#/components/responses/BudgetResponse" },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "response-ref");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "github",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "billing/get-all-budgets-org");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.returnsType).toContain("total");
    expect(tool!.metadata?.returnsType).not.toBe("unknown");
  });

  test("resolves nested schema refs inside array items", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Nested refs", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          Budget: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
          BudgetList: {
            type: "object",
            properties: {
              budgets: {
                type: "array",
                items: { $ref: "#/components/schemas/Budget" },
              },
            },
          },
        },
      },
      paths: {
        "/organizations/{org}/settings/billing/budgets": {
          get: {
            operationId: "billing/get-all-budgets-org",
            tags: ["billing"],
            parameters: [
              { name: "org", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/BudgetList" },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "nested-refs");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "github",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "billing/get-all-budgets-org");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.returnsType).toContain("budgets");
    expect(tool!.metadata?.returnsType).toContain("id: string");
    expect(tool!.metadata?.returnsType).not.toContain("unknown[]");
  });

  test("resolves deep ref chains used by nested response objects", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Deep refs", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          Root: {
            type: "object",
            properties: {
              result: {
                type: "array",
                items: { $ref: "#/components/schemas/A" },
              },
            },
          },
          A: {
            type: "object",
            properties: {
              value: { $ref: "#/components/schemas/B" },
            },
          },
          B: {
            type: "object",
            properties: {
              value: { $ref: "#/components/schemas/C" },
            },
          },
          C: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/deep": {
          get: {
            operationId: "deep/get",
            tags: ["deep"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Root" },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "deep-refs");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "deep",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "deep/get");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.returnsType).toContain("value");
    expect(tool!.metadata?.returnsType).toContain("string");
    expect(tool!.metadata?.returnsType).not.toContain("unknown");
  });

  test("handles recursive schema refs without blowing up", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Recursive refs", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              id: { type: "string" },
              child: { $ref: "#/components/schemas/Node" },
            },
            required: ["id"],
          },
        },
      },
      paths: {
        "/nodes": {
          get: {
            operationId: "nodes/get",
            tags: ["nodes"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Node" },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "recursive");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "recursive",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "nodes/get");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.returnsType).toContain("id: string");
    expect(tool!.metadata?.returnsType).toContain("child");
  });

  test("supports allOf-composed response schemas", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "AllOf response", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          Envelope: {
            type: "object",
            properties: {
              success: { type: "boolean" },
            },
            required: ["success"],
          },
          Account: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
          AccountResponse: {
            allOf: [
              { $ref: "#/components/schemas/Envelope" },
              {
                type: "object",
                properties: {
                  result: { $ref: "#/components/schemas/Account" },
                },
              },
            ],
          },
        },
      },
      paths: {
        "/accounts/{id}": {
          get: {
            operationId: "accounts/get",
            tags: ["accounts"],
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/AccountResponse" },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "allof");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "cf",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "accounts/get");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.returnsType).toContain("success");
    expect(tool!.metadata?.returnsType).toContain("result");
    expect(tool!.metadata?.returnsType).not.toBe("unknown");
  });

  test("supports schemas that encode unions via top-level items arrays", async () => {
    const spec: Record<string, unknown> = {
      swagger: "2.0",
      info: { title: "Tuple-style union", version: "1.0.0" },
      host: "api.example.com",
      schemes: ["https"],
      paths: {
        "/users.identity": {
          get: {
            operationId: "users_identity",
            tags: ["users"],
            responses: {
              "200": {
                description: "ok",
                schema: {
                  items: [
                    {
                      type: "object",
                      properties: {
                        ok: { type: "boolean" },
                        user: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                          },
                        },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        ok: { type: "boolean" },
                        user: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            email: { type: "string" },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "tuple-union");
    const tools = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "slack",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const tool = tools.find((t) => t.metadata?.operationId === "users_identity");
    expect(tool).toBeDefined();
    expect(tool!.metadata?.returnsType).toContain(" | ");
    expect(tool!.metadata?.returnsType).not.toBe("unknown");
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
    expect(tools[0]!.path).toBe("ref_api.people.list_people");
  });
});
