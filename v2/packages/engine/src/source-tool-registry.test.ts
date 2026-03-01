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
import {
  type SourceStore,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import { SourceSchema, type Source, type ToolArtifact } from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeOpenApiToolProvider } from "./openapi-provider";
import { makeToolProviderRegistry } from "./tool-providers";
import { createSourceToolRegistry } from "./source-tool-registry";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

type TestServer = {
  baseUrl: string;
  requests: Array<string>;
  close: () => Promise<void>;
};

class TestServerReleaseError extends Data.TaggedError("TestServerReleaseError")<{
  message: string;
}> {}

const githubOwnerParam = HttpApiSchema.param("owner", Schema.String);
const githubRepoParam = HttpApiSchema.param("repo", Schema.String);

class GitHubReposApi extends HttpApiGroup.make("repos").add(
  HttpApiEndpoint.get("getRepo")`/repos/${githubOwnerParam}/${githubRepoParam}`.addSuccess(
    Schema.Unknown,
  ),
) {}

class GitHubApi extends HttpApi.make("github").add(GitHubReposApi) {}

const githubOpenApiSpec = OpenApi.fromApi(GitHubApi);

const jsonResponse = (res: ServerResponse, statusCode: number, body: unknown): void => {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const getHeaderValue = (req: IncomingMessage, key: string): string | null => {
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
        const requests: Array<string> = [];

        const server = createServer((req, res) => {
          const host = getHeaderValue(req, "host") ?? "127.0.0.1";
          const url = new URL(req.url ?? "/", `http://${host}`);

          if (url.pathname === "/repos/octocat/hello-world" && req.method === "GET") {
            requests.push(url.pathname);
            jsonResponse(res, 200, {
              full_name: "octocat/hello-world",
              stargazers_count: 42,
            });
            return;
          }

          jsonResponse(res, 404, {
            error: "not found",
          });
        });

        server.once("error", (error) => reject(error));

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
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (cause) =>
        new TestServerReleaseError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.orDie),
);

describe("source tool registry", () => {
  it.scoped("discovers and invokes source-backed tools", () =>
    Effect.gen(function* () {
      const server = yield* makeTestServer;

      const source: Source = decodeSource({
        id: "src_github",
        workspaceId: "ws_local",
        name: "github",
        kind: "openapi",
        endpoint: server.baseUrl,
        status: "connected",
        enabled: true,
        configJson: "{}",
        sourceHash: null,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const sources: Array<Source> = [source];

      const sourceStore: SourceStore = {
        getById: (workspaceId, sourceId) =>
          Effect.succeed(
            Option.fromNullable(
              sources.find(
                (candidate) =>
                  candidate.workspaceId === workspaceId && candidate.id === sourceId,
              ),
            ),
          ),
        listByWorkspace: (workspaceId) =>
          Effect.succeed(
            sources.filter((candidate) => candidate.workspaceId === workspaceId),
          ),
        upsert: (nextSource) =>
          Effect.sync(() => {
            const index = sources.findIndex(
              (candidate) =>
                candidate.workspaceId === nextSource.workspaceId &&
                candidate.id === nextSource.id,
            );

            if (index >= 0) {
              sources[index] = nextSource;
              return;
            }

            sources.push(nextSource);
          }),
        removeById: (workspaceId, sourceId) =>
          Effect.sync(() => {
            const initialLength = sources.length;
            const nextSources = sources.filter(
              (candidate) =>
                !(candidate.workspaceId === workspaceId && candidate.id === sourceId),
            );
            sources.splice(0, sources.length, ...nextSources);
            return initialLength !== sources.length;
          }),
      };

      const artifactsByKey = new Map<string, ToolArtifact>();

      const toolArtifactStore: ToolArtifactStore = {
        getBySource: (workspaceId, sourceId) =>
          Effect.succeed(
            Option.fromNullable(artifactsByKey.get(`${workspaceId}:${sourceId}`)),
          ),
        upsert: (artifact) =>
          Effect.sync(() => {
            artifactsByKey.set(`${artifact.workspaceId}:${artifact.sourceId}`, artifact);
          }),
      };

      const sourceManager = makeSourceManagerService(toolArtifactStore);
      yield* sourceManager.refreshOpenApiArtifact({
        source,
        openApiSpec: githubOpenApiSpec,
      });

      const toolProviderRegistry = makeToolProviderRegistry([makeOpenApiToolProvider()]);

      const toolRegistry = createSourceToolRegistry({
        workspaceId: source.workspaceId,
        sourceStore,
        toolArtifactStore,
        toolProviderRegistry,
      });

      const discovered = yield* toolRegistry.discover({
        query: "repo",
        limit: 5,
      });

      expect(discovered.bestPath).not.toBeNull();
      expect(discovered.results.length).toBeGreaterThan(0);
      expect(discovered.results[0]?.typing).toBeUndefined();

      const discoveredWithSchemas = yield* toolRegistry.discover({
        query: "repo",
        includeSchemas: true,
      });
      expect(discoveredWithSchemas.results[0]?.typing?.inputSchemaJson).toBeDefined();
      expect(discoveredWithSchemas.results[0]?.inputHint).toContain("object");

      const compactDiscovered = yield* toolRegistry.discover({
        query: "repo",
        compact: true,
        includeSchemas: true,
      });
      expect(compactDiscovered.results[0]?.description).toBeUndefined();
      expect(compactDiscovered.results[0]?.inputHint).toBeUndefined();
      expect(compactDiscovered.results[0]?.outputHint).toBeUndefined();

      const bestPath = discovered.bestPath;
      if (!bestPath) {
        throw new Error("expected discover to return bestPath");
      }

      const invocationResult = yield* toolRegistry.callTool({
        runId: "run_source_registry_1",
        callId: "call_source_registry_1",
        toolPath: bestPath,
        input: {
          owner: "octocat",
          repo: "hello-world",
        },
      });

      expect(invocationResult).toMatchObject({
        ok: true,
        value: {
          status: 200,
          body: {
            full_name: "octocat/hello-world",
            stargazers_count: 42,
          },
        },
      });

      const namespaces = yield* toolRegistry.catalogNamespaces({});
      expect(namespaces.total).toBeGreaterThan(0);
      expect(namespaces.namespaces[0]?.samplePaths.length).toBeGreaterThan(0);

      const namespace = namespaces.namespaces[0]?.namespace;
      if (!namespace) {
        throw new Error("expected at least one namespace");
      }

      const catalog = yield* toolRegistry.catalogTools({
        namespace,
      });

      expect(catalog.results.length).toBeGreaterThan(0);
      expect(server.requests).toEqual(["/repos/octocat/hello-world"]);
    }),
  );
});
