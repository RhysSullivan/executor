import {
  createServer,
} from "node:http";
import type {
  AddressInfo,
} from "node:net";
import {
  FileSystem,
} from "@effect/platform";
import {
  NodeFileSystem,
} from "@effect/platform-node";
import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  createLocalExecutorEffect,
} from "@executor/platform-sdk-file/effect";
import {
  ExecutionIdSchema,
} from "../../schema";
import {
  RuntimeExecutionResolverService,
} from "../execution/scope/environment";
import {
  openApiSdkPlugin,
} from "../../../../../../plugins/openapi/sdk";

const staticOpenApiDocument = JSON.stringify({
  openapi: "3.1.0",
  info: {
    title: "Demo API",
    version: "1.0.0",
  },
  servers: [
    {
      url: "https://api.example.test",
    },
  ],
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        responses: {
          "200": {
            description: "ok",
          },
        },
      },
    },
  },
});

const startStaticSpecServer = async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/openapi.json") {
      response.writeHead(404);
      response.end("Not Found");
      return;
    }

    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(staticOpenApiDocument);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to determine OpenAPI test server address.");
  }

  return {
    specUrl: `http://127.0.0.1:${(address as AddressInfo).port}/openapi.json`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
};

const resolveExecutionEnvironment = (executor: {
  scopeId: string;
  actorScopeId: string;
  runtime: {
    runtimeLayer: any;
  };
}) =>
  Effect.gen(function* () {
    const resolver = yield* RuntimeExecutionResolverService;
    return yield* resolver({
      scopeId: executor.scopeId,
      actorScopeId: executor.actorScopeId,
      executionId: ExecutionIdSchema.make("exec_executor_tools_test"),
    });
  }).pipe(Effect.provide(executor.runtime.runtimeLayer));

describe("executor internal tools", () => {
  it.scoped("registers plugin-owned executor.openapi tools and delegates generic remove through them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectory({
        prefix: "executor-internal-tools-",
      });
      const stored = new Map<string, Record<string, unknown>>();
      const specServer = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => startStaticSpecServer(),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
        (server) =>
          Effect.promise(() => server.close()).pipe(Effect.orDie),
      );
      const executor = yield* Effect.acquireRelease(
        createLocalExecutorEffect({
          localDataDir: ":memory:",
          workspaceRoot,
          plugins: [
            openApiSdkPlugin({
              storage: {
                get: ({ sourceId }) =>
                  Effect.succeed((stored.get(sourceId) as any) ?? null),
                put: ({ sourceId, value }) =>
                  Effect.sync(() => {
                    stored.set(sourceId, value as any);
                  }),
                remove: ({ sourceId }) =>
                  Effect.sync(() => {
                    stored.delete(sourceId);
                  }),
              },
            }),
          ] as const,
        }),
        (openedExecutor) =>
          Effect.promise(() => openedExecutor.close()).pipe(
            Effect.orDie,
            Effect.zipRight(
              fs.remove(workspaceRoot, {
                recursive: true,
                force: true,
              }),
            ),
          ),
      );

      const environment = yield* resolveExecutionEnvironment(executor);
      expect(environment.catalog).toBeDefined();

      const createTool = yield* environment.catalog!.getToolByPath({
        path: "executor.openapi.createSource",
        includeSchemas: false,
      });
      const previewTool = yield* environment.catalog!.getToolByPath({
        path: "executor.openapi.previewDocument",
        includeSchemas: false,
      });

      expect(createTool?.path).toBe("executor.openapi.createSource");
      expect(previewTool?.path).toBe("executor.openapi.previewDocument");

      const preview = yield* environment.toolInvoker.invoke({
        path: "executor.openapi.previewDocument",
        args: {
          specUrl: specServer.specUrl,
        },
      });
      expect(preview).toMatchObject({
        title: "Demo API",
        operationCount: 1,
      });

      const created = yield* environment.toolInvoker.invoke({
        path: "executor.openapi.createSource",
        args: {
          name: "Demo API",
          specUrl: specServer.specUrl,
          baseUrl: null,
          auth: {
            kind: "none",
          },
        },
      });

      expect((created as { kind: string }).kind).toBe("openapi");
      expect(stored.has((created as { id: string }).id)).toBe(true);

      const removed = yield* environment.toolInvoker.invoke({
        path: "executor.sources.remove",
        args: {
          sourceId: (created as { id: string }).id,
        },
      });

      expect(removed).toEqual({
        removed: true,
      });
      expect(stored.has((created as { id: string }).id)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("keeps executor.sources.add as a compatibility alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectory({
        prefix: "executor-add-alias-",
      });
      const specServer = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => startStaticSpecServer(),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
        (server) =>
          Effect.promise(() => server.close()).pipe(Effect.orDie),
      );
      const executor = yield* Effect.acquireRelease(
        createLocalExecutorEffect({
          localDataDir: ":memory:",
          workspaceRoot,
          plugins: [
            openApiSdkPlugin({
              storage: {
                get: () => Effect.succeed(null),
                put: () => Effect.void,
                remove: () => Effect.void,
              },
            }),
          ] as const,
        }),
        (openedExecutor) =>
          Effect.promise(() => openedExecutor.close()).pipe(
            Effect.orDie,
            Effect.zipRight(
              fs.remove(workspaceRoot, {
                recursive: true,
                force: true,
              }),
            ),
          ),
      );

      const environment = yield* resolveExecutionEnvironment(executor);
      const aliasTool = yield* environment.catalog!.getToolByPath({
        path: "executor.sources.add",
        includeSchemas: false,
      });
      expect(aliasTool?.path).toBe("executor.sources.add");

      const created = yield* environment.toolInvoker.invoke({
        path: "executor.sources.add",
        args: {
          kind: "openapi",
          name: "Alias API",
          specUrl: specServer.specUrl,
          baseUrl: null,
          auth: {
            kind: "none",
          },
        },
      });

      expect(created).toMatchObject({
        kind: "openapi",
        name: "Alias API",
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
