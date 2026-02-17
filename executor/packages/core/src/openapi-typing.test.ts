import { describe, expect, test } from "bun:test";
import { buildOpenApiToolsFromPrepared, prepareOpenApiSpec } from "./tool-sources";

function makeLargeSpec(operationCount: number): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (let i = 0; i < operationCount; i += 1) {
    const tag = `resource_${i}`;
    const pathTemplate = `/api/v1/${tag}/{id}`;

    paths[pathTemplate] = {
      get: {
        operationId: `get_${tag}`,
        tags: [tag],
        summary: `Get ${tag} by ID`,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "include", in: "query", schema: { type: "string", enum: ["metadata", "related", "all"] } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
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
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                  },
                  required: ["id", "name"],
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: { title: "Large API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths,
  };
}

describe("OpenAPI schema-first typing", () => {
  test("buildOpenApiToolsFromPrepared emits input/output schemas and preview keys", async () => {
    const spec = makeLargeSpec(50);
    const prepared = await prepareOpenApiSpec(spec, "large", { includeDts: false, profile: "inventory" });

    const tools = buildOpenApiToolsFromPrepared(
      { type: "openapi", name: "large", spec, baseUrl: "https://api.example.com" },
      prepared,
    );

    expect(tools.length).toBeGreaterThan(0);

    const getTool = tools.find((t) => t.path.includes("get_resource_"));
    expect(getTool).toBeDefined();
    expect(getTool!.typing?.inputSchema).toBeDefined();
    expect(getTool!.typing?.outputSchema).toBeDefined();
    expect(getTool!.typing?.requiredInputKeys ?? []).toContain("id");
    expect(getTool!.typing?.previewInputKeys ?? []).toContain("include");
    expect(getTool!.typing?.inputHint).toContain("id: string");
    expect(getTool!.typing?.inputHint).toContain("include?:");
    expect(getTool!.typing?.typedRef).toBeDefined();
  });

  test("full profile with dts sets typedRef for OpenAPI operations", async () => {
    const spec = makeLargeSpec(3);
    const prepared = await prepareOpenApiSpec(spec, "large", { includeDts: true, profile: "full" });
    expect(prepared.dts).toBeDefined();

    const tools = buildOpenApiToolsFromPrepared(
      { type: "openapi", name: "large", spec, baseUrl: "https://api.example.com" },
      prepared,
    );

    const anyTyped = tools.find((t) => t.typing?.typedRef?.kind === "openapi_operation");
    expect(anyTyped).toBeDefined();
    expect(anyTyped!.typing!.typedRef!.sourceKey).toBe("openapi:large");
  });

  test("OpenAPI tools include ref hints for unresolved component refs", async () => {
    const wideMeta = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`field_${i}`, { type: "string" }]),
    );

    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Refs API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          DeepMeta: {
            type: "object",
            properties: wideMeta,
            required: ["field_0"],
          },
        },
      },
      paths: {
        "/contacts": {
          post: {
            operationId: "createContact",
            tags: ["contacts"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      payload: {
                        type: "object",
                        properties: {
                          meta: { $ref: "#/components/schemas/DeepMeta" },
                        },
                        required: ["meta"],
                      },
                    },
                    required: ["payload"],
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
                        ok: { type: "boolean" },
                      },
                      required: ["ok"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "refs", { includeDts: false, profile: "inventory" });
    const tools = buildOpenApiToolsFromPrepared(
      { type: "openapi", name: "refs", spec, baseUrl: "https://api.example.com" },
      prepared,
    );

    const createContact = tools.find((tool) => tool.path === "refs.contacts.create_contact");
    expect(createContact).toBeDefined();
    expect(createContact!.typing?.inputHint).toContain('components["schemas"]["DeepMeta"]');
    expect(createContact!.typing?.refHintKeys).toContain("DeepMeta");
    expect(prepared.refHintTable?.DeepMeta).toContain("field_0");
  });

  test("OpenAPI input hints compact allOf object intersections", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Certificates API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/projects/{project_id}/certificates": {
          post: {
            operationId: "addCertificates",
            tags: ["projects"],
            parameters: [
              {
                name: "project_id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      certificate_ids: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                    required: ["certificate_ids"],
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
                        ok: { type: "boolean" },
                      },
                      required: ["ok"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "certs", { includeDts: false, profile: "full" });
    const tools = buildOpenApiToolsFromPrepared(
      { type: "openapi", name: "certs", spec, baseUrl: "https://api.example.com" },
      prepared,
    );

    const addCertificates = tools.find((tool) => tool.typing?.typedRef?.operationId === "addCertificates");
    expect(addCertificates).toBeDefined();
    expect(addCertificates!.typing?.inputHint).toBe("{ project_id: string; certificate_ids: string[] }");
  });

  test("prepared spec stays reasonably small for many operations", async () => {
    const spec = makeLargeSpec(250);
    const prepared = await prepareOpenApiSpec(spec, "large", { includeDts: false, profile: "inventory" });
    const json = JSON.stringify(prepared);
    const sizeKB = json.length / 1024;
    console.log(`prepared OpenAPI (250 ops): ${sizeKB.toFixed(0)}KB`);
    // Loose threshold; this guards against accidentally embedding full .d.ts or huge raw specs.
    expect(json.length).toBeLessThan(5_000_000);
  }, 300_000);
});
