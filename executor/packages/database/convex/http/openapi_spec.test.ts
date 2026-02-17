import { describe, expect, test } from "bun:test";
import { buildOpenApiDocument, schemaFromValidator, type OpenApiFunctionSpec } from "./openapi_spec";
import { collectPublicFunctionSpecs } from "./openapi_spec_registry";

describe("openapi_spec", () => {
  test("builds object schemas with required fields", () => {
    const schema = schemaFromValidator({
      type: "object",
      value: {
        workspaceId: {
          fieldType: { type: "id", tableName: "workspaces" },
          optional: false,
        },
        sessionId: {
          fieldType: { type: "string" },
          optional: true,
        },
      },
    });

    expect(schema).toEqual({
      type: "object",
      required: ["workspaceId"],
      properties: {
        workspaceId: {
          type: "string",
          description: 'ID from table "workspaces"',
        },
        sessionId: {
          type: "string",
        },
      },
    });
  });

  test("parses stringified validator json", () => {
    const schema = schemaFromValidator(
      '{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false}}}',
    );

    expect(schema).toEqual({
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
        },
      },
    });
  });

  test("generates GET and POST operations from function specs", () => {
    const functions: OpenApiFunctionSpec[] = [
      {
        identifier: "app:getClientConfig",
        functionType: "query",
        method: "GET",
        args: { type: "object", value: {} },
        returns: { type: "object", value: {} },
      },
      {
        identifier: "workspace:upsertCredential",
        functionType: "mutation",
        method: "POST",
        args: { type: "object", value: {} },
        returns: { type: "any" },
      },
    ];

    const document = buildOpenApiDocument(functions, "https://example.convex.cloud");
    const paths = document.paths as Record<string, Record<string, unknown>>;

    expect(paths["/api/run/app/getClientConfig"]?.get).toBeDefined();
    expect(paths["/api/run/workspace/upsertCredential"]?.post).toBeDefined();
  });

  test("collects public function specs from convex modules", async () => {
    const specs = await collectPublicFunctionSpecs();
    const identifiers = new Set(specs.map((spec) => spec.identifier));

    expect(identifiers.has("app:getClientConfig")).toBe(true);
    expect(identifiers.has("workspace:listTasks")).toBe(true);
    expect(identifiers.has("executor:createTask")).toBe(true);

    const updateRole = specs.find((spec) => spec.identifier === "organizationMembers:updateRole");
    expect(typeof updateRole?.args).toBe("string");

    const updateRoleDoc = buildOpenApiDocument([updateRole!], "https://example.convex.cloud");
    const schemas = (updateRoleDoc.components as { schemas: Record<string, unknown> }).schemas;
    const argsSchema = schemas.Request_organizationMembers_updateRole as {
      properties?: Record<string, unknown>;
    };

    expect(argsSchema.properties?.accountId).toBeDefined();
    expect(argsSchema.properties?.role).toBeDefined();
  });
});
