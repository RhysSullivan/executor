import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { type ToolArtifactStore } from "@executor-v2/persistence-ports";
import { type Source, SourceSchema, type ToolArtifact } from "@executor-v2/schema";
import { makeSourceManagerService } from "@executor-v2/source-manager";
import * as Data from "effect/Data";
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
  close: () => Promise<void>;
};

class TestServerReleaseError extends Data.TaggedError("TestServerReleaseError")<{
  message: string;
}> {}

const jsonResponse = (res: ServerResponse, statusCode: number, body: unknown): void => {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const getHeaderValue = (
  req: IncomingMessage,
  key: string,
): string | null => {
  const value = req.headers[key];
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return null;
};

const makeTestServer = Effect.acquireRelease(
  Effect.promise<TestServer>(
    () =>
      new Promise<TestServer>((resolve, reject) => {
        const requests: TestServer["requests"] = [];

        const server = createServer((req, res) => {
          const host = getHeaderValue(req, "host") ?? "127.0.0.1";
          const url = new URL(req.url ?? "/", `http://${host}`);

          if (url.pathname === "/users/u123") {
            requests.push({
              path: url.pathname,
              query: url.search,
              apiKey: getHeaderValue(req, "x-api-key"),
            });

            jsonResponse(res, 200, {
              id: "u123",
              verbose: url.searchParams.get("verbose") === "true",
              apiKey: getHeaderValue(req, "x-api-key"),
            });
            return;
          }

          jsonResponse(res, 404, { error: "not found" });
        });

        server.once("error", (error) => {
          reject(error);
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve test server address"));
            return;
          }

          resolve({
            baseUrl: `http://127.0.0.1:${address.port}`,
            requests,
            close: () =>
              new Promise<void>((closeResolve, closeReject) => {
                server.close((error) => {
                  if (error) {
                    closeReject(error);
                    return;
                  }
                  closeResolve();
                });
              }),
          });
        });
      })
  ),
  (testServer) =>
    Effect.tryPromise({
      try: () => testServer.close(),
      catch: (cause) =>
        new TestServerReleaseError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.orDie),
);

describe("OpenAPI execution vertical slice", () => {
  it.scoped("extracts OpenAPI tools and executes code against provider", () =>
    Effect.gen(function* () {
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
    }),
  );

  it.scoped("uses configured source credentials when required header arg is omitted", () =>
    Effect.gen(function* () {
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
        configJson: JSON.stringify({
          type: "openapi",
          auth: {
            mode: "api_key",
            headerName: "x-api-key",
            value: "sk_from_config",
          },
        }),
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
  verbose: "true"
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
      expect(output.body.apiKey).toBe("sk_from_config");

      expect(testServer.requests).toHaveLength(1);
      expect(testServer.requests[0]?.path).toBe("/users/u123");
      expect(testServer.requests[0]?.query).toBe("?verbose=true");
      expect(testServer.requests[0]?.apiKey).toBe("sk_from_config");
    }),
  );
});
