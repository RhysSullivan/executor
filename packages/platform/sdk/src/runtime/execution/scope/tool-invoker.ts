import {
  createSystemToolMap,
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  mergeToolCatalogs,
  mergeToolMaps,
  type ToolCatalog,
  type ToolMap,
  type ToolInvoker,
} from "@executor/codemode-core";
import type {
  ScopeId,
  Source,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  RuntimeSourceCatalogStoreService,
} from "../../catalog/source/runtime";
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
  DeleteSecretMaterial,
  ResolveSecretMaterial,
  ResolveInstanceConfig,
  StoreSecretMaterial,
  UpdateSecretMaterial,
} from "../../scope/secret-material-providers";
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
  toSecretResolutionContext,
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
import {
  LocalInstanceConfigService,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
} from "../../scope/secret-material-providers";
import {
  ExecutorStateStore,
} from "../../executor-state-store";

export type ScopeInternalToolContext = {
  scopeId: Source["scopeId"];
  actorScopeId: ScopeId;
  executorStateStore: ExecutorStateStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSyncService: Effect.Effect.Success<
    typeof RuntimeSourceCatalogSyncService
  >;
  installationStore: InstallationStoreShape;
  instanceConfigResolver: ResolveInstanceConfig;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial: StoreSecretMaterial;
  deleteSecretMaterial: DeleteSecretMaterial;
  updateSecretMaterial: UpdateSecretMaterial;
  scopeConfigStore: ScopeConfigStoreShape;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalScope: RuntimeLocalScopeState | null;
};

export type CreateScopeInternalToolMap = (
  input: ScopeInternalToolContext,
) => ToolMap;

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
  instanceConfigResolver: ResolveInstanceConfig;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial: StoreSecretMaterial;
  deleteSecretMaterial: DeleteSecretMaterial;
  updateSecretMaterial: UpdateSecretMaterial;
  scopeConfigStore: ScopeConfigStoreShape;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalScope: RuntimeLocalScopeState | null;
  localToolRuntime: LocalToolRuntime;
  createInternalToolMap?: CreateScopeInternalToolMap;
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
  const provideWorkspaceStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(scopeStorageLayer));
  const persistedInvocationRuntimeLayer = Layer.mergeAll(
    scopeStorageLayer,
    Layer.succeed(ExecutorStateStore, input.executorStateStore),
    Layer.succeed(LocalInstanceConfigService, input.instanceConfigResolver),
    Layer.succeed(SecretMaterialResolverService, input.resolveSecretMaterial),
    Layer.succeed(SecretMaterialStorerService, input.storeSecretMaterial),
    Layer.succeed(SecretMaterialDeleterService, input.deleteSecretMaterial),
    Layer.succeed(SecretMaterialUpdaterService, input.updateSecretMaterial),
  );
  const providePersistedInvocationRuntime = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => effect.pipe(Effect.provide(persistedInvocationRuntimeLayer));

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
  const internalTools =
    input.createInternalToolMap?.({
      scopeId: input.scopeId,
      actorScopeId: input.actorScopeId,
      executorStateStore: input.executorStateStore,
      sourceStore: input.sourceStore,
      sourceCatalogSyncService: input.sourceCatalogSyncService,
      installationStore: input.installationStore,
      instanceConfigResolver: input.instanceConfigResolver,
      resolveSecretMaterial: input.resolveSecretMaterial,
      storeSecretMaterial: input.storeSecretMaterial,
      deleteSecretMaterial: input.deleteSecretMaterial,
      updateSecretMaterial: input.updateSecretMaterial,
      scopeConfigStore: input.scopeConfigStore,
      scopeStateStore: input.scopeStateStore,
      sourceArtifactStore: input.sourceArtifactStore,
      runtimeLocalScope: input.runtimeLocalScope,
    }) ?? {};
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
    internalTools,
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
      providePersistedInvocationRuntime(
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
