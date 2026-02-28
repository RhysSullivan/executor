import {
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import { type Source, SourceSchema, type ToolArtifact } from "@executor-v2/schema";
import { makeSourceManagerService } from "@executor-v2/source-manager";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { executeJavaScriptWithTools } from "./local-runner";
import {
  makeOpenApiToolProvider,
  openApiToolDescriptorsFromManifest,
} from "./openapi-provider";
import {
  makeToolProviderRegistry,
  ToolProviderRegistryService,
} from "./tool-providers";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

type TestServer = {
  baseUrl: string;
  requests: Array<{
    path: string;
    query: string;
    apiKey: string | null;
  }>;
  server: Bun.Server<unknown>;
};

const makeTestServer = Effect.acquireRelease(
  Effect.sync<TestServer>(() => {
    const requests: TestServer["requests"] = [];

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);

        if (url.pathname === "/users/u123") {
          requests.push({
            path: url.pathname,
            query: url.search,
            apiKey: request.headers.get("x-api-key"),
          });

          return Response.json({
            id: "u123",
            verbose: url.searchParams.get("verbose") === "true",
            apiKey: request.headers.get("x-api-key"),
          });
        }

        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    return {
      baseUrl: `http://127.0.0.1:${server.port}`,
      requests,
      server,
    };
  }),
  ({ server }) =>
    Effect.sync(() => {
      server.stop(true);
    }),
);

describe("OpenAPI execution vertical slice", () => {
  test("extracts OpenAPI tools and executes code against provider", async () => {
    const program = Effect.gen(function* () {
      const testServer = yield* makeTestServer;

      const openApiSpec = {
        openapi: "3.1.0",
        paths: {
          "/users/{userId}": {
            get: {
              operationId: "getUser",
              parameters: [
                {
                  name: "userId",
                  in: "path",
                  required: true,
                },
                {
                  name: "verbose",
                  in: "query",
                },
                {
                  name: "x-api-key",
                  in: "header",
                  required: true,
                },
              ],
            },
          },
        },
      };

      const source: Source = decodeSource({
        id: "src_openapi",
        workspaceId: "ws_local",
        name: "local-openapi",
        kind: "openapi",
        endpoint: testServer.baseUrl,
        status: "connected",
        enabled: true,
        configJson: "{}",
        sourceHash: null,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const artifactsByKey = new Map<string, ToolArtifact>();
      const artifactStore: ToolArtifactStore = {
        getBySource: (workspaceId: Source["workspaceId"], sourceId: Source["id"]) =>
          Effect.succeed(
            Option.fromNullable(artifactsByKey.get(`${workspaceId}:${sourceId}`)),
          ),
        upsert: (artifact: ToolArtifact) =>
          Effect.sync(() => {
            artifactsByKey.set(
              `${artifact.workspaceId}:${artifact.sourceId}`,
              artifact,
            );
          }),
      };
      const sourceManager = makeSourceManagerService(artifactStore);

      const refreshResult = yield* sourceManager.refreshOpenApiArtifact({
        source,
        openApiSpec,
      });

      const tools = yield* openApiToolDescriptorsFromManifest(
        source,
        refreshResult.artifact.manifestJson,
      );

      const getUserTool = tools.find((tool) => tool.toolId === "getUser");
      if (!getUserTool) {
        throw new Error("expected getUser tool");
      }

      const registry = makeToolProviderRegistry([makeOpenApiToolProvider()]);

      const executionResult = yield* executeJavaScriptWithTools({
        code: `
return await tools.getUser({
  userId: "u123",
  verbose: "true",
  "x-api-key": "sk_test"
});
`,
        tools: [
          {
            descriptor: getUserTool,
            source,
          },
        ],
      }).pipe(
        Effect.provideService(ToolProviderRegistryService, registry),
      );

      const output = executionResult as {
        status: number;
        body: {
          id: string;
          verbose: boolean;
          apiKey: string | null;
        };
      };

      expect(output.status).toBe(200);
      expect(output.body.id).toBe("u123");
      expect(output.body.verbose).toBe(true);
      expect(output.body.apiKey).toBe("sk_test");

      expect(testServer.requests).toHaveLength(1);
      expect(testServer.requests[0]?.path).toBe("/users/u123");
      expect(testServer.requests[0]?.query).toBe("?verbose=true");
      expect(testServer.requests[0]?.apiKey).toBe("sk_test");
    });

    await Effect.runPromise(program.pipe(Effect.scoped));
  });
});
