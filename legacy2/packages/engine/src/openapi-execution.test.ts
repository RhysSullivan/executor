import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { makeSourceManagerService } from "@executor-v2/management-api";
import { type ToolArtifactStore } from "@executor-v2/persistence-ports";
import { type Source, SourceSchema, type ToolArtifact } from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { executeJavaScriptWithTools } from "@executor-v2/runtime-local-inproc";
import { makeOpenApiToolProvider, openApiToolDescriptorsFromManifest } from "./openapi-provider";
import { RuntimeAdapterError } from "./runtime-adapters";
import { makeToolProviderRegistry } from "./tool-providers";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

type TestServer = {
  baseUrl: string;
  requests: Array<{
    path: string;
    accept: string | null;
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

const githubOwnerParam = HttpApiSchema.param("owner", Schema.String);
const githubRepoParam = HttpApiSchema.param("repo", Schema.String);

class GitHubReposApi extends HttpApiGroup.make("repos").add(
  HttpApiEndpoint.get("getRepo")`/repos/${githubOwnerParam}/${githubRepoParam}`.addSuccess(
    Schema.Unknown,
  ),
) {}

class GitHubApi extends HttpApi.make("github").add(GitHubReposApi) {}

const githubOpenApiSpec = OpenApi.fromApi(GitHubApi);

const quoteJavaScriptString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const makeTestServer = Effect.acquireRelease(
  Effect.promise<TestServer>(
    () =>
      new Promise<TestServer>((resolve, reject) => {
        const requests: TestServer["requests"] = [];

        const server = createServer((req, res) => {
          const host = getHeaderValue(req, "host") ?? "127.0.0.1";
          const url = new URL(req.url ?? "/", `http://${host}`);

          if (url.pathname === "/repos/octocat/hello-world" && req.method === "GET") {
            requests.push({
              path: url.pathname,
              accept: getHeaderValue(req, "accept"),
            });

            jsonResponse(res, 200, {
              full_name: "octocat/hello-world",
              stargazers_count: 42,
              private: false,
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
      }),
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
  it.scoped("loads GitHub OpenAPI tool and executes it in sandbox", () =>
    Effect.gen(function* () {
      const testServer = yield* makeTestServer;

      const source: Source = decodeSource({
        id: "src_openapi",
        workspaceId: "ws_local",
        name: "github",
        kind: "openapi",
        endpoint: testServer.baseUrl,
        status: "connected",
        enabled: true,
        configJson: JSON.stringify({ baseUrl: testServer.baseUrl }),
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
            artifactsByKey.set(`${artifact.workspaceId}:${artifact.sourceId}`, artifact);
          }),
      };

      const sourceManager = makeSourceManagerService(artifactStore);
      const refreshResult = yield* sourceManager.refreshOpenApiArtifact({
        source,
        openApiSpec: githubOpenApiSpec,
      });

      const tools = yield* openApiToolDescriptorsFromManifest(
        source,
        refreshResult.artifact.manifestJson,
      );

      expect(tools).toHaveLength(1);
      const githubTool = tools[0]!;

      const registry = makeToolProviderRegistry([makeOpenApiToolProvider()]);

      const executionResult = yield* executeJavaScriptWithTools({
        runId: "run_openapi_1",
        code: `return await tools[${quoteJavaScriptString(githubTool.toolId)}]({ owner: "octocat", repo: "hello-world" });`,
        toolCallService: {
          callTool: (input) => {
            if (input.toolPath !== githubTool.toolId) {
              return new RuntimeAdapterError({
                operation: "call_tool",
                runtimeKind: "local-inproc",
                message: `Unknown tool path: ${input.toolPath}`,
                details: null,
              });
            }

            return registry
              .invoke({
                source,
                tool: githubTool,
                args: input.input ?? {},
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RuntimeAdapterError({
                      operation: "call_tool",
                      runtimeKind: "local-inproc",
                      message: error.message,
                      details: null,
                    }),
                ),
                Effect.flatMap((result) =>
                  result.isError
                    ? Effect.fail(
                        new RuntimeAdapterError({
                          operation: "call_tool",
                          runtimeKind: "local-inproc",
                          message: `Tool call returned error: ${input.toolPath}`,
                          details: null,
                        }),
                      )
                    : Effect.succeed(result.output),
                ),
              );
          },
        },
      });

      expect(executionResult).toMatchObject({
        status: 200,
        body: {
          full_name: "octocat/hello-world",
          stargazers_count: 42,
          private: false,
        },
      });

      const executionWithNestedPathArgs = yield* executeJavaScriptWithTools({
        runId: "run_openapi_2",
        code: `return await tools[${quoteJavaScriptString(githubTool.toolId)}]({ path: { owner: "octocat", repo: "hello-world" } });`,
        toolCallService: {
          callTool: (input) => {
            if (input.toolPath !== githubTool.toolId) {
              return new RuntimeAdapterError({
                operation: "call_tool",
                runtimeKind: "local-inproc",
                message: `Unknown tool path: ${input.toolPath}`,
                details: null,
              });
            }

            return registry
              .invoke({
                source,
                tool: githubTool,
                args: input.input ?? {},
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RuntimeAdapterError({
                      operation: "call_tool",
                      runtimeKind: "local-inproc",
                      message: error.message,
                      details: null,
                    }),
                ),
                Effect.flatMap((result) =>
                  result.isError
                    ? Effect.fail(
                        new RuntimeAdapterError({
                          operation: "call_tool",
                          runtimeKind: "local-inproc",
                          message: `Tool call returned error: ${input.toolPath}`,
                          details: null,
                        }),
                      )
                    : Effect.succeed(result.output),
                ),
              );
          },
        },
      });

      expect(executionWithNestedPathArgs).toMatchObject({
        status: 200,
        body: {
          full_name: "octocat/hello-world",
          stargazers_count: 42,
          private: false,
        },
      });

      expect(testServer.requests).toHaveLength(2);
      expect(testServer.requests[0]?.path).toBe("/repos/octocat/hello-world");
      expect(testServer.requests[1]?.path).toBe("/repos/octocat/hello-world");
    }),
  );
});
