import {
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
} from "@executor/codemode-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  ExecutionEnvironment,
  ResolveExecutionEnvironment,
} from "../state";
import {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "../runtime";
import {
  createScopeToolInvoker,
} from "./tool-invoker";
import {
  RuntimeSourceCatalogStoreService,
} from "../../catalog/source/runtime";
import {
  RuntimeSourceCatalogSyncService,
} from "../../catalog/source/sync";
import {
  getRuntimeLocalScopeOption,
} from "../../scope/runtime-context";
import {
  LocalToolRuntimeLoaderService,
  type LocalToolRuntimeLoaderShape,
  type LocalToolRuntime,
} from "../../local-tool-runtime";
import {
  InstallationStore,
  type InstallationStoreShape,
  SourceArtifactStore,
  type SourceArtifactStoreShape,
  ScopeConfigStore,
  type ScopeConfigStoreShape,
  ScopeStateStore,
  type ScopeStateStoreShape,
} from "../../scope/storage";
import {
  ExecutorStateStore,
} from "../../executor-state-store";
import {
  RuntimeSourceStoreService,
} from "../../sources/source-store";
import {
  ExecutorPluginRegistryService,
} from "../../sources/source-plugins";
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
export {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "../runtime";

const createEmptyLocalToolRuntime = (): LocalToolRuntime => ({
  tools: {},
  catalog: createToolCatalogFromTools({ tools: {} }),
  toolInvoker: makeToolInvokerFromTools({ tools: {} }),
  toolPaths: new Set<string>(),
});

export const createScopeExecutionEnvironmentResolver =
  (input: {
    pluginRegistry: Effect.Effect.Success<typeof ExecutorPluginRegistryService>;
    executorStateStore: Effect.Effect.Success<typeof ExecutorStateStore>;
    sourceStore: Effect.Effect.Success<typeof RuntimeSourceStoreService>;
    sourceCatalogSyncService: Effect.Effect.Success<
      typeof RuntimeSourceCatalogSyncService
    >;
    sourceCatalogStore: Effect.Effect.Success<
      typeof RuntimeSourceCatalogStoreService
    >;
    localToolRuntimeLoader: LocalToolRuntimeLoaderShape;
    installationStore: InstallationStoreShape;
    scopeConfigStore: ScopeConfigStoreShape;
    scopeStateStore: ScopeStateStoreShape;
    sourceArtifactStore: SourceArtifactStoreShape;
    secretMaterialServices: {
      resolve: ResolveSecretMaterial;
      store: StoreSecretMaterial;
      delete: DeleteSecretMaterial;
      update: UpdateSecretMaterial;
    };
  }): ResolveExecutionEnvironment =>
  ({ scopeId, actorScopeId, onElicitation }) =>
    Effect.gen(function* () {
      const runtimeLocalScope = yield* getRuntimeLocalScopeOption();
      const loadedConfig =
        runtimeLocalScope === null
          ? null
          : yield* input.scopeConfigStore.load();
      const localToolRuntime =
        runtimeLocalScope === null
          ? createEmptyLocalToolRuntime()
          : yield* input.localToolRuntimeLoader.load();
      const { catalog, toolInvoker } = createScopeToolInvoker({
        pluginRegistry: input.pluginRegistry,
        scopeId,
        actorScopeId,
        executorStateStore: input.executorStateStore,
        sourceStore: input.sourceStore,
        sourceCatalogSyncService: input.sourceCatalogSyncService,
        sourceCatalogStore: input.sourceCatalogStore,
        installationStore: input.installationStore,
        scopeConfigStore: input.scopeConfigStore,
        scopeStateStore: input.scopeStateStore,
        sourceArtifactStore: input.sourceArtifactStore,
        runtimeLocalScope,
        localToolRuntime,
        secretMaterialServices: input.secretMaterialServices,
        onElicitation,
      });

      const executor = createCodeExecutorForRuntime(
        resolveConfiguredExecutionRuntime(loadedConfig?.config),
      );

      return {
        executor,
        toolInvoker,
        catalog,
      } satisfies ExecutionEnvironment;
    });

export class RuntimeExecutionResolverService extends Context.Tag(
  "#runtime/RuntimeExecutionResolverService",
)<
  RuntimeExecutionResolverService,
  ReturnType<typeof createScopeExecutionEnvironmentResolver>
>() {}

export const RuntimeExecutionResolverLive = (
  input: {
    executionResolver?: ResolveExecutionEnvironment;
  } = {},
) =>
  input.executionResolver
    ? Layer.succeed(RuntimeExecutionResolverService, input.executionResolver)
    : Layer.effect(
        RuntimeExecutionResolverService,
        Effect.gen(function* () {
          const pluginRegistry = yield* ExecutorPluginRegistryService;
          const executorStateStore = yield* ExecutorStateStore;
          const sourceStore = yield* RuntimeSourceStoreService;
          const sourceCatalogSyncService =
            yield* RuntimeSourceCatalogSyncService;
          const sourceCatalogStore = yield* RuntimeSourceCatalogStoreService;
          const localToolRuntimeLoader = yield* LocalToolRuntimeLoaderService;
          const installationStore = yield* InstallationStore;
          const scopeConfigStore = yield* ScopeConfigStore;
          const scopeStateStore = yield* ScopeStateStore;
          const sourceArtifactStore = yield* SourceArtifactStore;
          const resolveSecretMaterial = yield* SecretMaterialResolverService;
          const storeSecretMaterial = yield* SecretMaterialStorerService;
          const deleteSecretMaterial = yield* SecretMaterialDeleterService;
          const updateSecretMaterial = yield* SecretMaterialUpdaterService;

          return createScopeExecutionEnvironmentResolver({
            pluginRegistry,
            executorStateStore,
            sourceStore,
            sourceCatalogSyncService,
            sourceCatalogStore,
            localToolRuntimeLoader,
            installationStore,
            scopeConfigStore,
            scopeStateStore,
            sourceArtifactStore,
            secretMaterialServices: {
              resolve: resolveSecretMaterial,
              store: storeSecretMaterial,
              delete: deleteSecretMaterial,
              update: updateSecretMaterial,
            },
          });
        }),
      );
