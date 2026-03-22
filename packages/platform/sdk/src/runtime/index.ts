import {
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  type ToolMap,
} from "@executor/codemode-core";
import { clearAllMcpConnectionPools } from "@executor/source-mcp";
import type { LocalInstallation } from "#schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { RuntimeSourceAuthMaterialLive } from "./auth/source-auth-material";
import { RuntimeSourceCatalogStoreLive } from "./catalog/source/runtime";
import { reconcileMissingSourceCatalogArtifacts } from "./catalog/source/reconcile";
import { RuntimeSourceCatalogSyncLive } from "./catalog/source/sync";
import {
  SourceTypeDeclarationsRefresherService,
  type SourceTypeDeclarationsRefresherShape,
} from "./catalog/source/type-declarations";
import { createLiveExecutionManager, LiveExecutionManagerService } from "./execution/live";
import { RuntimeExecutionResolverLive } from "./execution/workspace/environment";
import type { CreateWorkspaceInternalToolMap, WorkspaceInternalToolContext } from "./execution/workspace/tool-invoker";
import type { LoadedLocalExecutorConfig } from "./workspace-config";
import type { LocalExecutorConfig } from "#schema";
import type { InstanceConfig } from "../local/contracts";
import type {
  ExecutorWorkspaceContext,
  ExecutorWorkspaceDescriptor,
} from "../workspace";
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
} from "./workspace/secret-material-providers";
import type { LocalSourceArtifact } from "./source-artifacts";
import {
  type RuntimeLocalWorkspaceState,
  RuntimeLocalWorkspaceLive,
} from "./workspace/runtime-context";
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
  type WorkspaceConfigStoreShape,
  type WorkspaceStateStoreShape,
} from "./workspace/storage";
import type { LocalWorkspaceState } from "./workspace-state";
import { synchronizeLocalWorkspaceState } from "./workspace/workspace-sync";
import { ExecutorStateStore, type ExecutorStateStoreShape } from "./executor-state-store";
import { RuntimeSourceAuthServiceLive } from "./sources/source-auth-service";
import { RuntimeSourceStoreLive } from "./sources/source-store";

export * from "./execution/state";
export * from "./sources/executor-tools";
export * from "./execution/live";
export * from "./catalog/schema-type-signature";
export * from "./catalog/source/runtime";
export * from "./catalog/source/sync";
export * from "./sources/source-auth-service";
export * from "./sources/source-credential-interactions";
export * from "./sources/source-adapters/mcp";
export * from "./sources/source-store";
export * from "./executor-state-store";
export * from "./execution/workspace/environment";
export * from "../sources/inspection";
export * from "../sources/discovery";
export * from "./execution/service";
export type {
  CreateWorkspaceInternalToolMap,
  WorkspaceInternalToolContext,
} from "./execution/workspace/tool-invoker";
export {
  LocalInstanceConfigService,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
} from "./workspace/secret-material-providers";
export type {
  DeleteSecretMaterial,
  ResolveInstanceConfig,
  ResolveSecretMaterial,
  StoreSecretMaterial,
  UpdateSecretMaterial,
} from "./workspace/secret-material-providers";
export {
  builtInSourceAdapters,
  connectableSourceAdapters,
  executorAddableSourceAdapters,
  localConfigurableSourceAdapters,
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
  createInternalToolMap?: CreateWorkspaceInternalToolMap;
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

export type BoundWorkspaceConfigStore = {
  load: () => Effect.Effect<LoadedLocalExecutorConfig, Error, never>;
  writeProject: (
    config: LocalExecutorConfig,
  ) => Effect.Effect<void, Error, never>;
  resolveRelativePath: WorkspaceConfigStoreShape["resolveRelativePath"];
};

export type BoundWorkspaceStateStore = {
  load: () => Effect.Effect<LocalWorkspaceState, Error, never>;
  write: (
    state: LocalWorkspaceState,
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

export type RuntimeInstanceConfigService = {
  resolve: () => Effect.Effect<InstanceConfig, Error, never>;
};

export type RuntimeStorageServices = {
  installation: BoundInstallationStore;
  workspaceConfig: BoundWorkspaceConfigStore;
  workspaceState: BoundWorkspaceStateStore;
  sourceArtifacts: BoundSourceArtifactStore;
  executorState: ExecutorStateStoreShape;
  secretMaterial: RuntimeSecretMaterialServices;
  close?: () => Promise<void>;
};

export type ExecutorRuntimeServices = {
  workspace: ExecutorWorkspaceDescriptor;
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

const toWorkspaceConfigStoreShape = (
  input: BoundWorkspaceConfigStore,
): WorkspaceConfigStoreShape => ({
  load: input.load,
  writeProject: ({ config }) => input.writeProject(config),
  resolveRelativePath: input.resolveRelativePath,
});

const toWorkspaceStateStoreShape = (
  input: BoundWorkspaceStateStore,
): WorkspaceStateStoreShape => ({
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

export const createExecutorRuntimeLayer = (
  input: ExecutorRuntimeOptions & ExecutorRuntimeServices & {
    localWorkspaceState: RuntimeLocalWorkspaceState;
    liveExecutionManager: ReturnType<typeof createLiveExecutionManager>;
  },
) => {
  const storageLayer = makeLocalStorageLayer({
    installationStore: toInstallationStoreShape(input.storage.installation),
    workspaceConfigStore: toWorkspaceConfigStoreShape(input.storage.workspaceConfig),
    workspaceStateStore: toWorkspaceStateStoreShape(input.storage.workspaceState),
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
    Layer.succeed(ExecutorStateStore, input.storage.executorState),
    RuntimeLocalWorkspaceLive(input.localWorkspaceState),
    storageLayer,
    Layer.succeed(LiveExecutionManagerService, input.liveExecutionManager),
    sourceTypeDeclarationsRefresherLayer,
  );

  const secretMaterialLayer = makeSecretMaterialLayer(input.storage.secretMaterial).pipe(
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

    const loadedLocalConfig = yield* input.services.storage.workspaceConfig
      .load()
      .pipe(Effect.mapError(toRuntimeBootstrapError));

    const runtimeWorkspace: ExecutorWorkspaceContext = {
      ...input.services.workspace,
      workspaceId: localInstallation.workspaceId,
      accountId: localInstallation.accountId,
    };
    const effectiveLocalConfig = yield* synchronizeLocalWorkspaceState({
      loadedConfig: loadedLocalConfig,
    })
      .pipe(
        Effect.provide(
          makeLocalStorageLayer({
            installationStore: toInstallationStoreShape(
              input.services.storage.installation,
            ),
            workspaceConfigStore: toWorkspaceConfigStoreShape(
              input.services.storage.workspaceConfig,
            ),
            workspaceStateStore: toWorkspaceStateStoreShape(
              input.services.storage.workspaceState,
            ),
            sourceArtifactStore: toSourceArtifactStoreShape(
              input.services.storage.sourceArtifacts,
            ),
          }),
        ),
      )
      .pipe(Effect.mapError(toRuntimeBootstrapError));
    const runtimeLocalWorkspaceState: RuntimeLocalWorkspaceState = {
      workspace: runtimeWorkspace,
      installation: {
        workspaceId: localInstallation.workspaceId,
        accountId: localInstallation.accountId,
      },
      loadedConfig: {
        ...loadedLocalConfig,
        config: effectiveLocalConfig,
      },
    };
    const liveExecutionManager = createLiveExecutionManager();

    const concreteRuntimeLayer = createExecutorRuntimeLayer({
      ...input,
      ...input.services,
      localWorkspaceState: runtimeLocalWorkspaceState,
      liveExecutionManager,
    });
    const managedRuntime = ManagedRuntime.make(concreteRuntimeLayer);
    yield* managedRuntime.runtimeEffect;
    yield* reconcileMissingSourceCatalogArtifacts({
      workspaceId: localInstallation.workspaceId,
      actorAccountId: localInstallation.accountId,
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
        await Effect.runPromise(clearAllMcpConnectionPools()).catch(
          () => undefined,
        );
        await managedRuntime.dispose().catch(() => undefined);
        await input.services.storage.close?.().catch(() => undefined);
      },
    };
  }) as Effect.Effect<ExecutorRuntime, Error>);
