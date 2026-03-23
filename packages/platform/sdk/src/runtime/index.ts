import {
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  type ToolMap,
} from "@executor/codemode-core";
import type {
  LocalInstallation,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
  RuntimeSourceAuthMaterialLive,
} from "./auth/source-auth-material";
import {
  RuntimeSourceCatalogStoreService,
  RuntimeSourceCatalogStoreLive,
} from "./catalog/source/runtime";
import {
  reconcileMissingSourceCatalogArtifacts,
} from "./catalog/source/reconcile";
import {
  RuntimeSourceCatalogSyncLive,
} from "./catalog/source/sync";
import {
  SourceTypeDeclarationsRefresherService,
  type SourceTypeDeclarationsRefresherShape,
} from "./catalog/source/type-declarations";
import {
  createLiveExecutionManager,
  LiveExecutionManagerService,
} from "./execution/live";
import {
  RuntimeExecutionResolverLive,
} from "./execution/scope/environment";
import type {
  CreateScopeInternalToolMap,
  ScopeInternalToolContext,
} from "./execution/scope/tool-invoker";
import type {
  LoadedLocalExecutorConfig,
} from "./scope-config";
import type {
  LocalExecutorConfig,
} from "#schema";
import type {
  InstanceConfig,
} from "../local/contracts";
import type {
  ExecutorScopeContext,
  ExecutorScopeDescriptor,
} from "../scope";
import {
  LocalInstanceConfigService,
  type DeleteSecretMaterial,
  type ResolveSecretMaterial,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  type StoreSecretMaterial,
  type UpdateSecretMaterial,
} from "./scope/secret-material-providers";
import type {
  LocalSourceArtifact,
} from "./source-artifacts";
import {
  type RuntimeLocalScopeState,
  RuntimeLocalScopeLive,
} from "./scope/runtime-context";
import {
  type LocalToolRuntime,
  type LocalToolRuntimeLoaderShape,
  LocalToolRuntimeLoaderService,
} from "./local-tool-runtime";
import {
  InstallationStore,
  makeLocalStorageLayer,
  type InstallationStoreShape,
  type SourceArtifactStoreShape,
  type ScopeConfigStoreShape,
  type ScopeStateStoreShape,
} from "./scope/storage";
import type {
  LocalScopeState,
} from "./scope-state";
import {
  synchronizeLocalScopeState,
} from "./scope/scope-sync";
import {
  ExecutorStateStore,
  type ExecutorStateStoreShape,
} from "./executor-state-store";
import {
  RuntimeSourceAuthServiceLive,
} from "./sources/source-auth-service";
import {
  RuntimeSourceStoreLive,
} from "./sources/source-store";

export * from "./execution/state";
export * from "./sources/executor-tools";
export * from "./execution/live";
export * from "./catalog/schema-type-signature";
export * from "./catalog/source/runtime";
export * from "./catalog/source/sync";
export * from "./sources/source-auth-service";
export * from "./sources/source-credential-interactions";
export * from "./sources/source-store";
export * from "./executor-state-store";
export * from "./execution/scope/environment";
export * from "../sources/inspection";
export * from "../sources/discovery";
export * from "./execution/service";
export type {
  CreateScopeInternalToolMap,
  ScopeInternalToolContext,
} from "./execution/scope/tool-invoker";
export {
  LocalInstanceConfigService,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
} from "./scope/secret-material-providers";
export type {
  DeleteSecretMaterial,
  ResolveInstanceConfig,
  ResolveSecretMaterial,
  StoreSecretMaterial,
  UpdateSecretMaterial,
} from "./scope/secret-material-providers";
export {
  builtInSourceAdapters,
  connectableSourceAdapters,
  executorAddableSourceAdapters,
  localConfigurableSourceAdapters,
  hasRegisteredConnectableSourceAdapters,
  hasRegisteredExecutorAddableSourceAdapters,
  hasRegisteredExternalSourceAdapters,
  getSourceAdapter,
  getSourceAdapterForSource,
  findSourceAdapterByProviderKey,
  sourceBindingStateFromSource,
  sourceAdapterCatalogKind,
  sourceAdapterRequiresInteractiveConnect,
  sourceAdapterUsesCredentialManagedAuth,
  isInternalSourceAdapter,
} from "./sources/source-adapters";

export type ExecutorRuntimeOptions = {
  executionResolver?: ResolveExecutionEnvironment;
  createInternalToolMap?: CreateScopeInternalToolMap;
  resolveSecretMaterial?: ResolveSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
};

type ResolveExecutionEnvironment = import("./execution/state").ResolveExecutionEnvironment;

const detailsFromCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toRuntimeBootstrapError = (cause: unknown): Error => {
  const details = detailsFromCause(cause);
  return new Error(`Failed initializing runtime: ${details}`);
};

export type ExecutorRuntimeLayer = Layer.Layer<any, never, never>;

export type BoundInstallationStore = {
  load: () => Effect.Effect<LocalInstallation, Error, never>;
  getOrProvision: () => Effect.Effect<LocalInstallation, Error, never>;
};

export type BoundScopeConfigStore = {
  load: () => Effect.Effect<LoadedLocalExecutorConfig, Error, never>;
  writeProject: (
    config: LocalExecutorConfig,
  ) => Effect.Effect<void, Error, never>;
  resolveRelativePath: ScopeConfigStoreShape["resolveRelativePath"];
};

export type BoundScopeStateStore = {
  load: () => Effect.Effect<LocalScopeState, Error, never>;
  write: (
    state: LocalScopeState,
  ) => Effect.Effect<void, Error, never>;
};

export type BoundSourceArtifactStore = {
  build: SourceArtifactStoreShape["build"];
  read: (
    sourceId: string,
  ) => Effect.Effect<LocalSourceArtifact | null, Error, never>;
  write: (input: {
    sourceId: string;
    artifact: LocalSourceArtifact;
  }) => Effect.Effect<void, Error, never>;
  remove: (sourceId: string) => Effect.Effect<void, Error, never>;
};

export type BoundLocalToolRuntimeLoader = {
  load: () => ReturnType<LocalToolRuntimeLoaderShape["load"]>;
};

export type BoundSourceTypeDeclarationsRefresher =
  SourceTypeDeclarationsRefresherShape;

export type RuntimeSecretMaterialServices = {
  resolve: ResolveSecretMaterial;
  store: StoreSecretMaterial;
  delete: DeleteSecretMaterial;
  update: UpdateSecretMaterial;
};

export type RuntimeAuthStorageServices = {
  artifacts: ExecutorStateStoreShape["authArtifacts"];
  leases: ExecutorStateStoreShape["authLeases"];
  sourceOauthClients: ExecutorStateStoreShape["sourceOauthClients"];
  scopeOauthClients: ExecutorStateStoreShape["scopeOauthClients"];
  providerGrants: ExecutorStateStoreShape["providerAuthGrants"];
  sourceSessions: ExecutorStateStoreShape["sourceAuthSessions"];
};

export const prewarmWorkspaceSourceCatalogToolIndex = (input: {
  scopeId: LocalInstallation["scopeId"];
  actorScopeId: LocalInstallation["actorScopeId"];
}) =>
  Effect.gen(function* () {
    const sourceCatalogStore = yield* RuntimeSourceCatalogStoreService;
    yield* sourceCatalogStore.loadWorkspaceSourceCatalogToolIndex({
      scopeId: input.scopeId,
      actorScopeId: input.actorScopeId,
    });
  });

export type RuntimeSecretsStorageServices =
  & ExecutorStateStoreShape["secretMaterials"]
  & RuntimeSecretMaterialServices;

export type RuntimeExecutionStorageServices = {
  runs: ExecutorStateStoreShape["executions"];
  interactions: ExecutorStateStoreShape["executionInteractions"];
  steps: ExecutorStateStoreShape["executionSteps"];
};

export type RuntimeInstanceConfigService = {
  resolve: () => Effect.Effect<InstanceConfig, Error, never>;
};

export type RuntimeStorageServices = {
  installation: BoundInstallationStore;
  scopeConfig: BoundScopeConfigStore;
  scopeState: BoundScopeStateStore;
  sourceArtifacts: BoundSourceArtifactStore;
  auth: RuntimeAuthStorageServices;
  secrets: RuntimeSecretsStorageServices;
  executions: RuntimeExecutionStorageServices;
  close?: () => Promise<void>;
};

export type ExecutorRuntimeServices = {
  scope: ExecutorScopeDescriptor;
  storage: RuntimeStorageServices;
  localToolRuntimeLoader?: BoundLocalToolRuntimeLoader;
  sourceTypeDeclarationsRefresher?: BoundSourceTypeDeclarationsRefresher;
  instanceConfig: RuntimeInstanceConfigService;
};

const emptyToolRuntime = (): LocalToolRuntime => {
  const tools: ToolMap = {};
  return {
    tools,
    catalog: createToolCatalogFromTools({ tools }),
    toolInvoker: makeToolInvokerFromTools({ tools }),
    toolPaths: new Set(),
  };
};

const noopSourceTypeDeclarationsRefresher: BoundSourceTypeDeclarationsRefresher = {
  refreshWorkspaceInBackground: () => Effect.void,
  refreshSourceInBackground: () => Effect.void,
};

const toInstallationStoreShape = (
  input: BoundInstallationStore,
): InstallationStoreShape => ({
  load: input.load,
  getOrProvision: input.getOrProvision,
});

const toScopeConfigStoreShape = (
  input: BoundScopeConfigStore,
): ScopeConfigStoreShape => ({
  load: input.load,
  writeProject: ({ config }) => input.writeProject(config),
  resolveRelativePath: input.resolveRelativePath,
});

const toScopeStateStoreShape = (
  input: BoundScopeStateStore,
): ScopeStateStoreShape => ({
  load: input.load,
  write: ({ state }) => input.write(state),
});

const toSourceArtifactStoreShape = (
  input: BoundSourceArtifactStore,
): SourceArtifactStoreShape => ({
  build: input.build,
  read: ({ sourceId }) => input.read(sourceId),
  write: ({ sourceId, artifact }) => input.write({ sourceId, artifact }),
  remove: ({ sourceId }) => input.remove(sourceId),
});

const makeSecretMaterialLayer = (input: RuntimeSecretMaterialServices) =>
  Layer.mergeAll(
    Layer.succeed(SecretMaterialResolverService, input.resolve),
    Layer.succeed(SecretMaterialStorerService, input.store),
    Layer.succeed(SecretMaterialDeleterService, input.delete),
    Layer.succeed(SecretMaterialUpdaterService, input.update),
  );

const makeInstanceConfigLayer = (input: RuntimeInstanceConfigService) =>
  Layer.succeed(LocalInstanceConfigService, input.resolve);

const toExecutorStateStoreShape = (
  input: RuntimeStorageServices,
): ExecutorStateStoreShape => ({
  authArtifacts: input.auth.artifacts,
  authLeases: input.auth.leases,
  sourceOauthClients: input.auth.sourceOauthClients,
  scopeOauthClients: input.auth.scopeOauthClients,
  providerAuthGrants: input.auth.providerGrants,
  sourceAuthSessions: input.auth.sourceSessions,
  secretMaterials: input.secrets,
  executions: input.executions.runs,
  executionInteractions: input.executions.interactions,
  executionSteps: input.executions.steps,
});

export const createExecutorRuntimeLayer = (
  input: ExecutorRuntimeOptions & ExecutorRuntimeServices & {
    localScopeState: RuntimeLocalScopeState;
    liveExecutionManager: ReturnType<typeof createLiveExecutionManager>;
  },
) => {
  const storageLayer = makeLocalStorageLayer({
    installationStore: toInstallationStoreShape(input.storage.installation),
    scopeConfigStore: toScopeConfigStoreShape(input.storage.scopeConfig),
    scopeStateStore: toScopeStateStoreShape(input.storage.scopeState),
    sourceArtifactStore: toSourceArtifactStoreShape(input.storage.sourceArtifacts),
  });
  const localToolRuntimeLayer = Layer.succeed(
    LocalToolRuntimeLoaderService,
    LocalToolRuntimeLoaderService.of({
      load: () =>
        input.localToolRuntimeLoader?.load() ?? Effect.succeed(emptyToolRuntime()),
    }),
  );
  const sourceTypeDeclarationsRefresherLayer = Layer.succeed(
    SourceTypeDeclarationsRefresherService,
    SourceTypeDeclarationsRefresherService.of(
      input.sourceTypeDeclarationsRefresher
        ?? noopSourceTypeDeclarationsRefresher,
    ),
  );

  const baseLayer = Layer.mergeAll(
    Layer.succeed(ExecutorStateStore, toExecutorStateStoreShape(input.storage)),
    RuntimeLocalScopeLive(input.localScopeState),
    storageLayer,
    Layer.succeed(LiveExecutionManagerService, input.liveExecutionManager),
    sourceTypeDeclarationsRefresherLayer,
  );

  const secretMaterialLayer = makeSecretMaterialLayer(input.storage.secrets).pipe(
    Layer.provide(baseLayer),
  );
  const instanceConfigLayer = makeInstanceConfigLayer(input.instanceConfig);

  const sourceStoreLayer = RuntimeSourceStoreLive.pipe(
    Layer.provide(Layer.mergeAll(baseLayer, secretMaterialLayer)),
  );

  const sourceCatalogStoreLayer = RuntimeSourceCatalogStoreLive.pipe(
    Layer.provide(Layer.mergeAll(baseLayer, sourceStoreLayer)),
  );

  const sourceAuthMaterialLayer = RuntimeSourceAuthMaterialLive.pipe(
    Layer.provide(Layer.mergeAll(baseLayer, secretMaterialLayer)),
  );

  const sourceCatalogSyncLayer = RuntimeSourceCatalogSyncLive.pipe(
    Layer.provide(
      Layer.mergeAll(baseLayer, secretMaterialLayer, sourceAuthMaterialLayer),
    ),
  );

  const sourceAuthLayer = RuntimeSourceAuthServiceLive({
    getLocalServerBaseUrl: input.getLocalServerBaseUrl,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        baseLayer,
        instanceConfigLayer,
        secretMaterialLayer,
        sourceStoreLayer,
        sourceCatalogSyncLayer,
      ),
    ),
  );

  const executionResolverLayer = RuntimeExecutionResolverLive({
    executionResolver: input.executionResolver,
    createInternalToolMap: input.createInternalToolMap,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        baseLayer,
        instanceConfigLayer,
        secretMaterialLayer,
        sourceStoreLayer,
        sourceAuthMaterialLayer,
        sourceCatalogSyncLayer,
        sourceAuthLayer,
        sourceCatalogStoreLayer,
        localToolRuntimeLayer,
      ),
    ),
  );

  return Layer.mergeAll(
    baseLayer,
    instanceConfigLayer,
    secretMaterialLayer,
    sourceStoreLayer,
    sourceAuthMaterialLayer,
    sourceCatalogSyncLayer,
    sourceCatalogStoreLayer,
    localToolRuntimeLayer,
    sourceAuthLayer,
    executionResolverLayer,
  ) as ExecutorRuntimeLayer;
};

export type ExecutorRuntime = {
  storage: RuntimeStorageServices;
  localInstallation: LocalInstallation;
  managedRuntime: ManagedRuntime.ManagedRuntime<any, never>;
  runtimeLayer: ExecutorRuntimeLayer;
  close: () => Promise<void>;
};

export const provideExecutorRuntime = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runtime: ExecutorRuntime,
): Effect.Effect<A, E | never, never> =>
  effect.pipe(Effect.provide(runtime.managedRuntime));

export const createExecutorRuntimeFromServices = (input: {
  services: ExecutorRuntimeServices;
} & ExecutorRuntimeOptions): Effect.Effect<ExecutorRuntime, Error> =>
  (Effect.gen(function* () {
    const localInstallation = yield* input.services.storage.installation
      .getOrProvision()
      .pipe(Effect.mapError(toRuntimeBootstrapError));

    const loadedLocalConfig = yield* input.services.storage.scopeConfig
      .load()
      .pipe(Effect.mapError(toRuntimeBootstrapError));

    const runtimeWorkspace: ExecutorScopeContext = {
      ...input.services.scope,
      scopeId: localInstallation.scopeId,
      actorScopeId: input.services.scope.actorScopeId ?? localInstallation.actorScopeId,
      resolutionScopeIds:
        input.services.scope.resolutionScopeIds ?? localInstallation.resolutionScopeIds,
    };
    const effectiveLocalConfig = yield* synchronizeLocalScopeState({
      loadedConfig: loadedLocalConfig,
    })
      .pipe(
        Effect.provide(
          makeLocalStorageLayer({
            installationStore: toInstallationStoreShape(
              input.services.storage.installation,
            ),
            scopeConfigStore: toScopeConfigStoreShape(
              input.services.storage.scopeConfig,
            ),
            scopeStateStore: toScopeStateStoreShape(
              input.services.storage.scopeState,
            ),
            sourceArtifactStore: toSourceArtifactStoreShape(
              input.services.storage.sourceArtifacts,
            ),
          }),
        ),
      )
      .pipe(Effect.mapError(toRuntimeBootstrapError));
    const runtimeLocalScopeState: RuntimeLocalScopeState = {
      scope: runtimeWorkspace,
      installation: localInstallation,
      loadedConfig: {
        ...loadedLocalConfig,
        config: effectiveLocalConfig,
      },
    };
    const liveExecutionManager = createLiveExecutionManager();

    const concreteRuntimeLayer = createExecutorRuntimeLayer({
      ...input,
      ...input.services,
      localScopeState: runtimeLocalScopeState,
      liveExecutionManager,
    });
    const managedRuntime = ManagedRuntime.make(concreteRuntimeLayer);
    yield* managedRuntime.runtimeEffect;
    yield* reconcileMissingSourceCatalogArtifacts({
      scopeId: localInstallation.scopeId,
      actorScopeId: localInstallation.actorScopeId,
    }).pipe(
      Effect.provide(managedRuntime),
      Effect.catchAll(() => Effect.void),
    );
    yield* prewarmWorkspaceSourceCatalogToolIndex({
      scopeId: localInstallation.scopeId,
      actorScopeId: localInstallation.actorScopeId,
    }).pipe(
      Effect.provide(managedRuntime),
      Effect.catchAll(() => Effect.void),
    );

    return {
      storage: input.services.storage,
      localInstallation,
      managedRuntime,
      runtimeLayer: concreteRuntimeLayer as ExecutorRuntimeLayer,
      close: async () => {
        await managedRuntime.dispose().catch(() => undefined);
        await input.services.storage.close?.().catch(() => undefined);
      },
    };
  }) as Effect.Effect<ExecutorRuntime, Error>);
