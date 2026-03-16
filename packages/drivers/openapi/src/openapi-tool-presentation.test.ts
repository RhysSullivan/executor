import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { OpenApiToolDefinition } from "./openapi-definitions";
import { compileOpenApiToolDefinitions } from "./openapi-definitions";
import { extractOpenApiManifest } from "./openapi-extraction";
import { buildOpenApiToolPresentation } from "./openapi-tool-presentation";

const readFixture = (name: string): string =>
  readFileSync(
    new URL(`../../../platform/control-plane/src/runtime/fixtures/${name}`, import.meta.url),
    "utf8",
  );

describe("buildOpenApiToolPresentation", () => {
  it("adds parameter descriptions to flattened call schemas", () => {
    const definition: OpenApiToolDefinition = {
      toolId: "accessGroups.deleteProject",
      rawToolId: "deleteAccessGroupProject",
      name: "Delete an access group project",
      description: "Allows deletion of an access group project",
      group: "accessGroups",
      leaf: "deleteProject",
      tags: [],
      versionSegment: "v1",
      method: "delete",
      path: "/v1/access-groups/{accessGroupIdOrName}/projects/{projectId}",
      invocation: {
        method: "delete",
        pathTemplate: "/v1/access-groups/{accessGroupIdOrName}/projects/{projectId}",
        parameters: [
          {
            name: "accessGroupIdOrName",
            location: "path",
            required: true,
          },
          {
            name: "projectId",
            location: "path",
            required: true,
          },
          {
            name: "teamId",
            location: "query",
            required: false,
          },
          {
            name: "slug",
            location: "query",
            required: false,
          },
        ],
        requestBody: null,
      },
      operationHash: "deadbeefcafebabe",
      typing: {
        inputSchema: {
          type: "object",
          properties: {
            accessGroupIdOrName: { type: "string" },
            projectId: { type: "string" },
            teamId: { type: "string" },
            slug: { type: "string" },
          },
          required: ["accessGroupIdOrName", "projectId"],
          additionalProperties: false,
        },
      },
      documentation: {
        summary: "Delete an access group project",
        parameters: [
          {
            name: "accessGroupIdOrName",
            location: "path",
            required: true,
            description: "The access group identifier or slug.",
          },
          {
            name: "projectId",
            location: "path",
            required: true,
            description: "The project identifier.",
          },
          {
            name: "teamId",
            location: "query",
            required: false,
            description: "The Team identifier to perform the request on behalf of.",
          },
          {
            name: "slug",
            location: "query",
            required: false,
            description: "The Team slug to perform the request on behalf of.",
          },
        ],
      },
    };

    const presentation = buildOpenApiToolPresentation({ definition });
    const schema = presentation.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };

    expect(schema.properties?.accessGroupIdOrName?.description).toBe(
      "The access group identifier or slug.",
    );
    expect(schema.properties?.projectId?.description).toBe(
      "The project identifier.",
    );
    expect(schema.properties?.teamId?.description).toBe(
      "The Team identifier to perform the request on behalf of.",
    );
    expect(schema.properties?.slug?.description).toBe(
      "The Team slug to perform the request on behalf of.",
    );
  });

  it("uses the request body property schema instead of nesting the full input schema", () => {
    const definition: OpenApiToolDefinition = {
      toolId: "projects.update",
      rawToolId: "updateProject",
      name: "Update project",
      description: "Updates a project.",
      group: "projects",
      leaf: "update",
      tags: [],
      versionSegment: "v1",
      method: "patch",
      path: "/v1/projects/{projectId}",
      invocation: {
        method: "patch",
        pathTemplate: "/v1/projects/{projectId}",
        parameters: [
          {
            name: "projectId",
            location: "path",
            required: true,
          },
        ],
        requestBody: {
          required: true,
          contentTypes: ["application/json"],
        },
      },
      operationHash: "feedfacecafebeef",
      typing: {
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
            },
            body: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
          required: ["projectId", "body"],
          additionalProperties: false,
        },
      },
      documentation: {
        parameters: [
          {
            name: "projectId",
            location: "path",
            required: true,
            description: "The project identifier.",
          },
        ],
        requestBody: {
          description: "Project update payload.",
        },
      },
    };

    const presentation = buildOpenApiToolPresentation({ definition });
    const schema = presentation.inputSchema as {
      properties?: Record<string, unknown>;
    };
    const body = schema.properties?.body as {
      description?: string;
      properties?: Record<string, unknown>;
    };

    expect(body.description).toBe("Project update payload.");
    expect(body.properties?.name).toEqual({ type: "string" });
    expect(body.properties?.body).toBeUndefined();
  });

  it.effect(
    "resolves request and response schemas from ref hints for the real Neon OpenAPI spec",
    () =>
      Effect.gen(function* () {
        const specText = readFixture("neon-openapi.json");
        const manifest = yield* extractOpenApiManifest("neon", specText);
        const definition = compileOpenApiToolDefinitions(manifest).find(
          (candidate) => candidate.toolId === "apiKey.createApiKey",
        );

        expect(definition).toBeDefined();

        const presentation = buildOpenApiToolPresentation({
          definition: definition!,
          refHintTable: manifest.refHintTable,
        });

        expect(presentation.inputTypePreview).toContain("body");
        expect(presentation.inputTypePreview).toContain("key_name");
        expect(presentation.outputTypePreview).toContain("key");
        expect(presentation.inputSchema).toMatchObject({
          type: "object",
          properties: {
            body: {
              type: "object",
              properties: {
                key_name: {
                  type: "string",
                },
              },
              required: ["key_name"],
            },
          },
          required: ["body"],
        });
        expect(presentation.outputSchema).toMatchObject({
          type: "object",
          properties: {
            id: {
              type: "integer",
            },
            key: {
              type: "string",
            },
            name: {
              type: "string",
            },
          },
        });
      }),
    120_000,
  );

  it.effect(
    "preserves response wrappers for response-only Neon operations",
    () =>
      Effect.gen(function* () {
        const specText = readFixture("neon-openapi.json");
        const manifest = yield* extractOpenApiManifest("neon", specText);
        const definition = compileOpenApiToolDefinitions(manifest).find(
          (candidate) => candidate.toolId === "apiKey.listApiKeys",
        );

        expect(definition).toBeDefined();

        const presentation = buildOpenApiToolPresentation({
          definition: definition!,
          refHintTable: manifest.refHintTable,
        });

        expect(presentation.inputTypePreview).toBe("unknown");
        expect(presentation.outputTypePreview).toContain("id");
        expect(presentation.outputTypePreview).toContain("name");
        expect(presentation.outputSchema).toMatchObject({
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "integer",
              },
              name: {
                type: "string",
              },
            },
          },
        });
      }),
    120_000,
  );

  it.effect(
    "extracts parameter schemas and descriptions for parameter-only Vercel operations",
    () =>
      Effect.gen(function* () {
        const specText = readFixture("vercel-openapi.json");
        const manifest = yield* extractOpenApiManifest("vercel", specText);
        const definition = compileOpenApiToolDefinitions(manifest).find(
          (candidate) => candidate.toolId === "accessGroups.listAccessGroupProjects",
        );

        expect(definition).toBeDefined();

        const presentation = buildOpenApiToolPresentation({
          definition: definition!,
          refHintTable: manifest.refHintTable,
        });

        expect(definition?.documentation?.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "idOrName",
              description: "The ID or name of the Access Group.",
            }),
            expect.objectContaining({
              name: "limit",
              description: "Limit how many access group projects should be returned.",
            }),
          ]),
        );
        expect(presentation.inputSchema).toMatchObject({
          type: "object",
          properties: {
            idOrName: {
              type: "string",
              description: "The ID or name of the Access Group.",
            },
            limit: {
              type: "integer",
              description: "Limit how many access group projects should be returned.",
              minimum: 1,
              maximum: 100,
            },
            next: {
              type: "string",
              description: "Continuation cursor to retrieve the next page of results.",
            },
            teamId: {
              type: "string",
              description: "The Team identifier to perform the request on behalf of.",
            },
            slug: {
              type: "string",
              description: "The Team slug to perform the request on behalf of.",
            },
          },
          required: ["idOrName"],
        });
      }),
    120_000,
  );
});
