import {
  createSystemToolMap,
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  mergeToolCatalogs,
  mergeToolMaps,
  type ToolCatalog,
  type ToolInvoker,
} from "@executor/codemode-core";
import type {
  ScopeId,
  Source,
} from "#schema";
import * as Effect from "effect/Effect";

import {
  RuntimeSourceCatalogStoreService,
} from "../../catalog/source/runtime";
import {
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  type DeleteSecretMaterial,
  type ResolveSecretMaterial,
  type StoreSecretMaterial,
  type UpdateSecretMaterial,
} from "../../scope/secret-material-providers";
import type {
  RuntimeLocalScopeState,
} from "../../scope/runtime-context";
import {
  type LocalToolRuntime,
} from "../../local-tool-runtime";
import {
  type InstallationStoreShape,
  makeScopeStorageLayer,
  type SourceArtifactStoreShape,
  type ScopeConfigStoreShape,
  type ScopeStateStoreShape,
} from "../../scope/storage";
import type {
  ExecutorStateStoreShape,
} from "../../executor-state-store";
import {
  type RuntimeSourceStore,
} from "../../sources/source-store";
import {
  createExecutorToolMap,
} from "../../sources/executor-tools";
import {
  RuntimeSourceCatalogSyncService,
} from "../../catalog/source/sync";
import {
  invokeIrTool,
} from "../ir-execution";
import {
  authorizePersistedToolInvocation,
} from "./authorization";
import {
  provideRuntimeLocalScope,
} from "./local";
import {
  createScopeSourceCatalog,
  loadWorkspaceCatalogToolByPath,
} from "./source-catalog";
import {
  runtimeEffectError,
} from "../../effect-errors";
import * as Layer from "effect/Layer";

export const createScopeToolInvoker = (input: {
  scopeId: Source["scopeId"];
  actorScopeId: ScopeId;
  executorStateStore: ExecutorStateStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSyncService: Effect.Effect.Success<
    typeof RuntimeSourceCatalogSyncService
  >;
  sourceCatalogStore: Effect.Effect.Success<
    typeof RuntimeSourceCatalogStoreService
  >;
  installationStore: InstallationStoreShape;
  scopeConfigStore: ScopeConfigStoreShape;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalScope: RuntimeLocalScopeState | null;
  localToolRuntime: LocalToolRuntime;
  secretMaterialServices: {
    resolve: ResolveSecretMaterial;
    store: StoreSecretMaterial;
    delete: DeleteSecretMaterial;
    update: UpdateSecretMaterial;
  };
  onElicitation?: Parameters<
    typeof makeToolInvokerFromTools
  >[0]["onElicitation"];
}): {
  catalog: ToolCatalog;
  toolInvoker: ToolInvoker;
} => {
  const scopeStorageLayer = makeScopeStorageLayer({
    scopeConfigStore: input.scopeConfigStore,
    scopeStateStore: input.scopeStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });
  const secretMaterialLayer = Layer.mergeAll(
    Layer.succeed(SecretMaterialResolverService, input.secretMaterialServices.resolve),
    Layer.succeed(SecretMaterialStorerService, input.secretMaterialServices.store),
    Layer.succeed(SecretMaterialDeleterService, input.secretMaterialServices.delete),
    Layer.succeed(SecretMaterialUpdaterService, input.secretMaterialServices.update),
  );
  const provideWorkspaceStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(scopeStorageLayer));
  const provideSecretMaterialServices = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => effect.pipe(Effect.provide(secretMaterialLayer));

  const executorTools = createExecutorToolMap({
    scopeId: input.scopeId,
    actorScopeId: input.actorScopeId,
    executorStateStore: input.executorStateStore,
    sourceStore: input.sourceStore,
    sourceCatalogSyncService: input.sourceCatalogSyncService,
    installationStore: input.installationStore,
    scopeConfigStore: input.scopeConfigStore,
    scopeStateStore: input.scopeStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
    runtimeLocalScope: input.runtimeLocalScope,
  });
  const sourceCatalog = createScopeSourceCatalog({
    scopeId: input.scopeId,
    actorScopeId: input.actorScopeId,
    sourceCatalogStore: input.sourceCatalogStore,
    scopeConfigStore: input.scopeConfigStore,
    scopeStateStore: input.scopeStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
    runtimeLocalScope: input.runtimeLocalScope,
  });
  let catalog: ToolCatalog | null = null;
  const systemTools = createSystemToolMap({
    getCatalog: () => {
      if (catalog === null) {
        throw new Error("Workspace tool catalog has not been initialized");
      }

      return catalog;
    },
  });
  const authoredTools = mergeToolMaps([
    systemTools,
    executorTools,
    input.localToolRuntime.tools,
  ]);
  const authoredCatalog = createToolCatalogFromTools({
    tools: authoredTools,
  });
  catalog = mergeToolCatalogs({
    catalogs: [authoredCatalog, sourceCatalog],
  });
  const authoredToolPaths = new Set(Object.keys(authoredTools));
  const authoredInvoker = makeToolInvokerFromTools({
    tools: authoredTools,
    onElicitation: input.onElicitation,
  });

  const invokePersistedTool = (invocation: {
    path: string;
    args: unknown;
    context?: Record<string, unknown>;
  }) =>
    provideRuntimeLocalScope(
      provideSecretMaterialServices(
        provideWorkspaceStorage(
        Effect.gen(function* () {
          const catalogTool = yield* loadWorkspaceCatalogToolByPath({
            scopeId: input.scopeId,
            actorScopeId: input.actorScopeId,
            sourceCatalogStore: input.sourceCatalogStore,
            path: invocation.path,
            includeSchemas: false,
          });
          if (!catalogTool) {
            return yield* runtimeEffectError(
              "execution/scope/tool-invoker",
              `Unknown tool path: ${invocation.path}`,
            );
          }

          yield* authorizePersistedToolInvocation({
            scopeId: input.scopeId,
            tool: catalogTool,
            args: invocation.args,
            context: invocation.context,
            onElicitation: input.onElicitation,
          });

          return yield* invokeIrTool({
            scopeId: input.scopeId,
            actorScopeId: input.actorScopeId,
            tool: catalogTool,
            args: invocation.args,
            onElicitation: input.onElicitation,
            context: invocation.context,
          });
        }),
        ),
      ),
      input.runtimeLocalScope,
    );

  return {
    catalog,
    toolInvoker: {
      invoke: ({ path, args, context }) => {
        const effect = authoredToolPaths.has(path)
          ? authoredInvoker.invoke({ path, args, context })
          : invokePersistedTool({ path, args, context }) as Effect.Effect<
              unknown,
              unknown,
              never
            >;

        return provideRuntimeLocalScope(effect, input.runtimeLocalScope);
      },
    },
  };
};
