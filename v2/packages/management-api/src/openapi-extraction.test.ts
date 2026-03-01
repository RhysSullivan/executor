import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { extractOpenApiManifest } from "./openapi-extraction";

describe("extractOpenApiManifest invocation metadata", () => {
  it.effect("extracts parameter and request body metadata", () =>
    Effect.gen(function* () {
      const openApiSpec = {
        openapi: "3.1.0",
        paths: {
          "/users/{userId}": {
            parameters: [
              { name: "userId", in: "path" },
              { name: "x-org-id", in: "header", required: true },
            ],
            get: {
              operationId: "getUser",
              summary: "Get user",
              parameters: [
                { name: "include", in: "query" },
                { name: "x-org-id", in: "header", required: false },
              ],
            },
            post: {
              summary: "Update user",
              requestBody: {
                required: true,
                content: {
                  "application/merge-patch+json": {},
                  "application/json": {},
                },
              },
            },
          },
        },
      };

      const manifest = yield* extractOpenApiManifest("test-source", openApiSpec);

      const getTool = manifest.tools.find((tool) => tool.toolId === "getUser");
      expect(getTool).toBeDefined();
      if (!getTool) {
        throw new Error("expected getUser tool");
      }

      expect(getTool.invocation.method).toBe("get");
      expect(getTool.invocation.pathTemplate).toBe("/users/{userId}");
      expect(getTool.invocation.requestBody).toBeNull();

      expect(getTool.invocation.parameters).toEqual(
        expect.arrayContaining([
          { name: "userId", location: "path", required: true },
          { name: "x-org-id", location: "header", required: false },
          { name: "include", location: "query", required: false },
        ]),
      );

      const postTool = manifest.tools.find(
        (tool) => tool.toolId === "post_users_userid",
      );
      expect(postTool).toBeDefined();
      if (!postTool) {
        throw new Error("expected post tool");
      }

      expect(postTool.invocation.requestBody).toEqual({
        required: true,
        contentTypes: ["application/json", "application/merge-patch+json"],
      });
    }),
  );

  it.effect("extracts typing payload and ref hint table from schemas", () =>
    Effect.gen(function* () {
      const openApiSpec = {
        openapi: "3.1.0",
        paths: {
          "/repos/{owner}/{repo}": {
            get: {
              operationId: "getRepo",
              parameters: [
                {
                  name: "owner",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
                {
                  name: "repo",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Repo" },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Repo: {
              type: "object",
              properties: {
                id: { type: "number" },
                owner: { $ref: "#/components/schemas/User" },
              },
            },
            User: {
              type: "object",
              properties: {
                login: { type: "string" },
              },
            },
          },
        },
      };

      const manifest = yield* extractOpenApiManifest("test-source", openApiSpec);
      const tool = manifest.tools.find((candidate) => candidate.toolId === "getRepo");
      const repoSchemaJson =
        '{"properties":{"id":{"type":"number"},"owner":{"$ref":"#/components/schemas/User"}},"type":"object"}';
      const userSchemaJson =
        '{"properties":{"login":{"type":"string"}},"type":"object"}';

      expect(tool?.typing?.inputSchemaJson).toBeDefined();
      expect(tool?.typing?.outputSchemaJson).toBeDefined();
      expect(tool?.typing?.refHintKeys).toEqual([
        "#/components/schemas/Repo",
      ]);
      expect(manifest.refHintTable).toEqual({
        "#/components/schemas/Repo": repoSchemaJson,
        "#/components/schemas/User": userSchemaJson,
      });
    }),
  );
});
