import { describe, expect, test } from "bun:test";
import { buildOpenApiToolsFromPrepared, prepareOpenApiSpec, serializeTools } from "./tool-sources";

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
    expect(getTool!.typing?.requiredInputKeys ?? []).toContain("path.id");
    expect(getTool!.typing?.previewInputKeys ?? []).toContain("query.include");
    expect(getTool!.typing?.inputHint).toContain("path");
    expect(getTool!.typing?.inputHint).toContain("query");
    expect(getTool!.typing?.typedRef).toBeDefined();
  });

  test("preserves OpenAPI parameter metadata in schemas and run specs", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Metadata API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/widgets/{id}": {
          get: {
            operationId: "getWidget",
            parameters: [
              {
                name: "id",
                in: "path",
                required: false,
                description: "Widget ID",
                schema: { type: "string" },
                example: "wid_123",
              },
              {
                name: "fields",
                in: "query",
                description: "Fields to include",
                style: "form",
                explode: false,
                allowReserved: true,
                schema: { type: "array", items: { type: "string" } },
                examples: {
                  minimal: { value: ["name"] },
                },
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
                        id: { type: "string" },
                      },
                      required: ["id"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "meta", { includeDts: false, profile: "full" });
    const tools = buildOpenApiToolsFromPrepared(
      { type: "openapi", name: "meta", spec, baseUrl: "https://api.example.com" },
      prepared,
    );

    const getWidget = tools.find((tool) => tool.typing?.typedRef?.operationId === "getWidget");
    expect(getWidget).toBeDefined();

    const inputSchema = (getWidget!.typing?.inputSchema ?? {}) as {
      properties?: Record<string, {
        properties?: Record<string, Record<string, unknown>>;
      }>;
      required?: string[];
    };
    expect(inputSchema.properties?.path?.properties?.id?.description).toBe("Widget ID");
    expect(inputSchema.properties?.path?.properties?.id?.example).toBe("wid_123");
    expect(inputSchema.properties?.query?.properties?.fields?.description).toBe("Fields to include");
    expect(inputSchema.properties?.query?.properties?.fields?.examples).toEqual([["name"]]);
    expect(inputSchema.required ?? []).toContain("path");

    const serialized = serializeTools([getWidget!])[0];
    expect(serialized).toBeDefined();
    if (!serialized || serialized.runSpec.kind !== "openapi") {
      throw new Error("Expected OpenAPI run spec");
    }

    const idParam = serialized.runSpec.parameters.find((parameter) => parameter.name === "id");
    expect(idParam?.required).toBe(true);
    expect(idParam?.description).toBe("Widget ID");
    expect(idParam?.example).toBe("wid_123");

    const fieldsParam = serialized.runSpec.parameters.find((parameter) => parameter.name === "fields");
    expect(fieldsParam?.style).toBe("form");
    expect(fieldsParam?.explode).toBe(false);
    expect(fieldsParam?.allowReserved).toBe(true);
    expect(fieldsParam?.examples).toEqual({ minimal: { value: ["name"] } });
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
    expect(addCertificates!.typing?.inputHint).toContain("path");
    expect(addCertificates!.typing?.inputHint).toContain("project_id");
    expect(addCertificates!.typing?.inputHint).toContain("body");
    expect(addCertificates!.typing?.inputHint).toContain("certificate_ids");
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
