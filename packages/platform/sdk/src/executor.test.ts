import { join } from "node:path";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpApiBuilder,
  HttpApiClient,
  FileSystem,
} from "@effect/platform";
import {
  NodeFileSystem,
  NodeHttpServer,
} from "@effect/platform-node";
import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Either from "effect/Either";
import {
  assertInclude,
} from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  makeOpenApiTestServer,
} from "@executor/effect-test-utils";

import {
  createExecutorBackend,
} from "./index";
import {
  createExecutorEffect,
  type ExecutorEffect as Executor,
} from "./effect";
import {
  type LocalInstallation,
  ScopeIdSchema,
} from "./schema";
import {
  createLocalExecutorServicesEffect,
} from "../../sdk-file/src/effect";
import {
  createExecutorApiLayer,
} from "../../api/src/http";
import {
  ExecutorApi,
} from "../../api/src/index";

type LocalExecutorServices = Effect.Effect.Success<
  ReturnType<typeof createLocalExecutorServicesEffect>
>;

const createClientLayer = (executor: Executor) =>
  HttpApiBuilder.serve().pipe(
    Layer.provide(createExecutorApiLayer(executor)),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );

const createExecutorApiClient = () =>
  HttpApiClient.make(ExecutorApi, {
  });

type ExecutorApiClient = Effect.Effect.Success<
  ReturnType<typeof createExecutorApiClient>
>;

const withExecutorApiClient = <A, E>(
  executor: Executor,
  f: (client: ExecutorApiClient) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const client = yield* createExecutorApiClient();
    return yield* f(client);
  }).pipe(Effect.provide(createClientLayer(executor).pipe(Layer.orDie)));

const expectLeft = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.either(effect).pipe(
    Effect.flatMap((result) =>
      Either.isLeft(result)
        ? Effect.succeed(result.left)
        : Effect.die("Expected effect to fail"),
    ),
  );

type OpenApiSpecServer = {
  baseUrl: string;
  specUrl: string;
  close: () => Promise<void>;
};

const ownerParam = HttpApiSchema.param("owner", Schema.String);
const repoParam = HttpApiSchema.param("repo", Schema.String);
const issueIdParam = HttpApiSchema.param("issueId", Schema.String);

class WorkspaceSourceReposApi extends HttpApiGroup.make("repos")
  .add(
    HttpApiEndpoint.get("getRepo")`/repos/${ownerParam}/${repoParam}`
      .addSuccess(Schema.Unknown),
  )
{}

class WorkspaceSourceIssuesApi extends HttpApiGroup.make("issues")
  .add(
    HttpApiEndpoint.get("getIssue")`/issues/${issueIdParam}`
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.get("listIssues")`/issues`
      .addSuccess(Schema.Unknown),
  )
{}

class WorkspaceSourceReposRootApi extends HttpApi.make("workspaceSourceRepos")
  .add(WorkspaceSourceReposApi)
{}

class WorkspaceSourceIssuesRootApi extends HttpApi.make("workspaceSourceIssues")
  .add(WorkspaceSourceIssuesApi)
{}

const workspaceSourceReposLive = HttpApiBuilder.group(
  WorkspaceSourceReposRootApi,
  "repos",
  (handlers) =>
    handlers.handle("getRepo", ({ path }) =>
      Effect.succeed({
        full_name: `${path.owner}/${path.repo}`,
        private: false,
      }),
    ),
);

const workspaceSourceIssuesLive = HttpApiBuilder.group(
  WorkspaceSourceIssuesRootApi,
  "issues",
  (handlers) =>
    handlers
      .handle("getIssue", ({ path }) =>
        Effect.succeed({
          id: path.issueId,
          title: `Issue ${path.issueId}`,
        }),
      )
      .handle("listIssues", () =>
        Effect.succeed([
          {
            id: "1",
            title: "Issue 1",
          },
        ]),
      ),
);

const workspaceSourceReposApiLayer = HttpApiBuilder.api(
  WorkspaceSourceReposRootApi,
).pipe(Layer.provide(workspaceSourceReposLive));

const workspaceSourceIssuesApiLayer = HttpApiBuilder.api(
  WorkspaceSourceIssuesRootApi,
).pipe(Layer.provide(workspaceSourceIssuesLive));

const createScopedExecutor = (input: {
  services: LocalExecutorServices;
  installation: LocalInstallation;
}) =>
  createExecutorEffect({
    backend: createExecutorBackend({
      loadServices: () =>
        Effect.succeed({
          ...input.services,
          scope: {
            ...input.services.scope,
            actorScopeId: input.installation.actorScopeId,
            resolutionScopeIds: input.installation.resolutionScopeIds,
          },
          storage: {
            ...input.services.storage,
            installation: {
              load: () => Effect.succeed(input.installation),
              getOrProvision: () => Effect.succeed(input.installation),
            },
          },
        }),
    }),
    getLocalServerBaseUrl: () => "http://127.0.0.1",
  });

const makeSharedScopeExecutors = Effect.acquireRelease(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sharedScopeId = ScopeIdSchema.make("org_shared_sdk_pair_test");

    const workspaceRootA = yield* fs.makeTempDirectoryScoped({
      prefix: "executor-sdk-scope-a-",
    });
    const workspaceRootB = yield* fs.makeTempDirectoryScoped({
      prefix: "executor-sdk-scope-b-",
    });

    const servicesA = yield* createLocalExecutorServicesEffect({
      workspaceRoot: workspaceRootA,
      homeConfigPath: join(workspaceRootA, ".executor-home.jsonc"),
      homeStateDirectory: join(workspaceRootA, ".executor-home-state"),
    });
    const servicesB = yield* createLocalExecutorServicesEffect({
      workspaceRoot: workspaceRootB,
      homeConfigPath: join(workspaceRootB, ".executor-home.jsonc"),
      homeStateDirectory: join(workspaceRootB, ".executor-home-state"),
    });

    const baseInstallationA =
      yield* servicesA.storage.installation.getOrProvision();
    const baseInstallationB =
      yield* servicesB.storage.installation.getOrProvision();

    const sharedStorageClose = (() => {
      let closed = false;
      return async () => {
        if (closed) {
          return;
        }
        closed = true;
        await servicesA.storage.close?.();
        await servicesB.storage.close?.();
      };
    })();

    const sharedStorage = {
      executorState: servicesA.storage.executorState,
      secretMaterial: servicesA.storage.secretMaterial,
      close: sharedStorageClose,
    };

    const installationA: LocalInstallation = {
      ...baseInstallationA,
      actorScopeId: ScopeIdSchema.make("acc_sdk_executor_a"),
      resolutionScopeIds: [
        baseInstallationA.scopeId,
        sharedScopeId,
        ScopeIdSchema.make("acc_sdk_executor_a"),
      ],
    };
    const installationB: LocalInstallation = {
      ...baseInstallationB,
      actorScopeId: ScopeIdSchema.make("acc_sdk_executor_b"),
      resolutionScopeIds: [
        baseInstallationB.scopeId,
        sharedScopeId,
        ScopeIdSchema.make("acc_sdk_executor_b"),
      ],
    };

    const executorA = yield* createScopedExecutor({
      services: {
        ...servicesA,
        storage: {
          ...servicesA.storage,
          ...sharedStorage,
        },
      },
      installation: installationA,
    });
    const executorB = yield* createScopedExecutor({
      services: {
        ...servicesB,
        storage: {
          ...servicesB.storage,
          ...sharedStorage,
        },
      },
      installation: installationB,
    });

    return {
      executorA,
      executorB,
      sharedScopeId,
    };
  }).pipe(Effect.provide(NodeFileSystem.layer)),
  ({ executorA, executorB }) =>
    Effect.promise(async () => {
      await executorA.close();
      await executorB.close();
    }).pipe(Effect.orDie),
);

describe("executor", () => {
  it.scoped(
    "keeps workspace sources isolated across executors that share an ancestor scope",
    () =>
      Effect.gen(function* () {
        const { executorA, executorB, sharedScopeId } =
          yield* makeSharedScopeExecutors;
        const openApiServer: OpenApiSpecServer = yield* makeOpenApiTestServer({
          apiLayer: workspaceSourceReposApiLayer,
        });

        expect(executorA.resolutionScopeIds).toContain(sharedScopeId);
        expect(executorB.resolutionScopeIds).toContain(sharedScopeId);

        const sourceA = yield* withExecutorApiClient(executorA, (client) =>
          client.sources.create({
            path: {
              workspaceId: executorA.scopeId,
            },
            payload: {
              name: "Workspace A Source",
              kind: "openapi",
              endpoint: openApiServer.baseUrl,
              namespace: "workspace.a",
              binding: {
                specUrl: openApiServer.specUrl,
                defaultHeaders: null,
              },
              auth: { kind: "none" },
            },
          }),
        );
        const sourceB = yield* withExecutorApiClient(executorB, (client) =>
          client.sources.create({
            path: {
              workspaceId: executorB.scopeId,
            },
            payload: {
              name: "Workspace B Source",
              kind: "openapi",
              endpoint: openApiServer.baseUrl,
              namespace: "workspace.b",
              binding: {
                specUrl: openApiServer.specUrl,
                defaultHeaders: null,
              },
              auth: { kind: "none" },
            },
          }),
        );

        const listedA = yield* withExecutorApiClient(executorA, (client) =>
          client.sources.list({
            path: {
              workspaceId: executorA.scopeId,
            },
          }),
        );
        const listedB = yield* withExecutorApiClient(executorB, (client) =>
          client.sources.list({
            path: {
              workspaceId: executorB.scopeId,
            },
          }),
        );

        expect(listedA.map((source) => source.id)).toEqual([sourceA.id]);
        expect(listedB.map((source) => source.id)).toEqual([sourceB.id]);

        const lookupFromSibling = yield* expectLeft(
          withExecutorApiClient(executorB, (client) =>
            client.sources.get({
              path: {
                workspaceId: executorB.scopeId,
                sourceId: sourceA.id,
              },
            }),
          ),
        );
        assertInclude(String(lookupFromSibling), "Source not found");
      }),
  );

  it.scoped(
    "keeps each executor's tool surface tied to its own workspace sources",
    () =>
      Effect.gen(function* () {
        const { executorA, executorB } =
          yield* makeSharedScopeExecutors;
        const openApiServerA: OpenApiSpecServer = yield* makeOpenApiTestServer({
          apiLayer: workspaceSourceReposApiLayer,
        });
        const openApiServerB: OpenApiSpecServer = yield* makeOpenApiTestServer({
          apiLayer: workspaceSourceIssuesApiLayer,
        });

        const sourceA = yield* withExecutorApiClient(executorA, (client) =>
          client.sources.create({
            path: {
              workspaceId: executorA.scopeId,
            },
            payload: {
              name: "Workspace A Tools",
              kind: "openapi",
              endpoint: openApiServerA.baseUrl,
              namespace: "workspace.a",
              binding: {
                specUrl: openApiServerA.specUrl,
                defaultHeaders: null,
              },
              auth: { kind: "none" },
            },
          }),
        );
        const sourceB = yield* withExecutorApiClient(executorB, (client) =>
          client.sources.create({
            path: {
              workspaceId: executorB.scopeId,
            },
            payload: {
              name: "Workspace B Tools",
              kind: "openapi",
              endpoint: openApiServerB.baseUrl,
              namespace: "workspace.b",
              binding: {
                specUrl: openApiServerB.specUrl,
                defaultHeaders: null,
              },
              auth: { kind: "none" },
            },
          }),
        );

        const inspectionA = yield* withExecutorApiClient(executorA, (client) =>
          client.sources.inspection({
            path: {
              workspaceId: executorA.scopeId,
              sourceId: sourceA.id,
            },
          }),
        );
        const inspectionB = yield* withExecutorApiClient(executorB, (client) =>
          client.sources.inspection({
            path: {
              workspaceId: executorB.scopeId,
              sourceId: sourceB.id,
            },
          }),
        );

        expect(inspectionA.toolCount).toBe(1);
        expect(inspectionB.toolCount).toBe(2);

        const siblingInspection = yield* expectLeft(
          withExecutorApiClient(executorA, (client) =>
            client.sources.inspection({
              path: {
                workspaceId: executorA.scopeId,
                sourceId: sourceB.id,
              },
            }),
          ),
        );
        assertInclude(String(siblingInspection), "Source not found");
      }),
    60_000,
  );
});
