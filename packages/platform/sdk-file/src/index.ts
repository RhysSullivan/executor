import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  createExecutor,
  createExecutorBackend,
  type Executor,
  type ExecutorBackend,
  type ExecutorBackendRepositories,
  type ExecutorScopeDescriptor,
  type ExecutorWorkspaceLocalToolRepository,
  type ExecutorWorkspaceSourceTypeDeclarationsRepository,
} from "@executor/platform-sdk";
import {
  createExecutorEffect,
  type CreateExecutorEffectOptions,
  type ExecutorEffect,
} from "@executor/platform-sdk/effect";
import type {
  ExecutorSdkPlugin,
  ExecutorSdkPluginExtensions,
} from "@executor/platform-sdk/plugins";
import type {
  LocalExecutorConfig,
  LocalInstallation,
} from "@executor/platform-sdk/schema";
import {
  type ExecutorRuntime,
  emptyExecutorPluginRegistry,
  type ExecutorRuntimeOptions,
  type ResolveSecretMaterial,
} from "@executor/platform-sdk/runtime";
import * as Effect from "effect/Effect";
import {
  type LoadedLocalExecutorConfig,
  type ResolvedLocalWorkspaceContext,
  loadLocalExecutorConfig,
  resolveConfigRelativePath,
  resolveLocalWorkspaceContext,
  writeProjectLocalExecutorConfig,
} from "./config";
import { createLocalExecutorStatePersistence } from "./executor-state-store";
import {
  createDefaultSecretMaterialDeleter,
  createLocalInstanceConfigResolver,
  createDefaultSecretMaterialResolver,
  createDefaultSecretMaterialStorer,
  createDefaultSecretMaterialUpdater,
  provisionBuiltinSecretStores,
} from "./secret-material-providers";
import {
  buildLocalSourceArtifact,
  readLocalSourceArtifact,
  removeLocalSourceArtifact,
  writeLocalSourceArtifact,
} from "./source-artifacts";
import {
  deriveLocalInstallation,
  getOrProvisionLocalInstallation,
  loadLocalInstallation,
} from "./installation";
import {
  loadLocalToolRuntime,
} from "./tools";
import {
  loadLocalWorkspaceState,
  writeLocalWorkspaceState,
} from "./workspace-state";
import {
  refreshSourceTypeDeclarationInBackground,
  refreshWorkspaceSourceTypeDeclarationsInBackground,
} from "./source-type-declarations";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const bindFileSystem = <A, E>(
  fileSystem: FileSystem.FileSystem,
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

export type CreateLocalExecutorBackendOptions = {
  cwd?: string;
  workspaceRoot?: string;
  homeConfigPath?: string;
  homeStateDirectory?: string;
  localDataDir?: string;
};

type CreateLocalRuntimeOptions = CreateLocalExecutorBackendOptions &
  ExecutorRuntimeOptions;

type LocalWorkspaceState = Parameters<
  typeof writeLocalWorkspaceState
>[0]["state"];

type LocalSourceArtifact = Parameters<
  typeof writeLocalSourceArtifact
>[0]["artifact"];

const createBoundInstallationStore = (
  context: ResolvedLocalWorkspaceContext,
): {
  load: () => Effect.Effect<LocalInstallation, Error, never>;
  getOrProvision: () => Effect.Effect<LocalInstallation, Error, never>;
} => ({
  load: () => loadLocalInstallation(context).pipe(Effect.mapError(toError)),
  getOrProvision: () =>
    getOrProvisionLocalInstallation({ context }).pipe(
      Effect.mapError(toError),
    ),
});

const createBoundWorkspaceConfigStore = (
  context: ResolvedLocalWorkspaceContext,
  fileSystem: FileSystem.FileSystem,
): {
  load: () => Effect.Effect<LoadedLocalExecutorConfig, Error, never>;
  writeProject: (config: LocalExecutorConfig) => Effect.Effect<void, Error, never>;
  resolveRelativePath: typeof resolveConfigRelativePath;
} => ({
  load: () =>
    bindFileSystem(fileSystem, loadLocalExecutorConfig(context)).pipe(
      Effect.mapError(toError),
    ),
  writeProject: (config) =>
    bindFileSystem(
      fileSystem,
      writeProjectLocalExecutorConfig({ context, config }),
    ).pipe(Effect.mapError(toError)),
  resolveRelativePath: resolveConfigRelativePath,
});

const createBoundWorkspaceStateStore = (
  context: ResolvedLocalWorkspaceContext,
  fileSystem: FileSystem.FileSystem,
): {
  load: () => Effect.Effect<LocalWorkspaceState, Error, never>;
  write: (state: LocalWorkspaceState) => Effect.Effect<void, Error, never>;
} => ({
  load: () =>
    bindFileSystem(fileSystem, loadLocalWorkspaceState(context)).pipe(
      Effect.mapError(toError),
    ),
  write: (state) =>
    bindFileSystem(
      fileSystem,
      writeLocalWorkspaceState({ context, state }),
    ).pipe(Effect.mapError(toError)),
});

const createBoundSourceArtifactStore = (
  context: ResolvedLocalWorkspaceContext,
  fileSystem: FileSystem.FileSystem,
): {
  build: typeof buildLocalSourceArtifact;
  read: (sourceId: string) => Effect.Effect<LocalSourceArtifact | null, Error, never>;
  write: (input: {
    sourceId: string;
    artifact: LocalSourceArtifact;
  }) => Effect.Effect<void, Error, never>;
  remove: (sourceId: string) => Effect.Effect<void, Error, never>;
} => ({
  build: buildLocalSourceArtifact,
  read: (sourceId) =>
    bindFileSystem(
      fileSystem,
      readLocalSourceArtifact({ context, sourceId }),
    ).pipe(Effect.mapError(toError)),
  write: ({ sourceId, artifact }) =>
    bindFileSystem(
      fileSystem,
      writeLocalSourceArtifact({ context, sourceId, artifact }),
    ).pipe(Effect.mapError(toError)),
  remove: (sourceId) =>
    bindFileSystem(
      fileSystem,
      removeLocalSourceArtifact({ context, sourceId }),
    ).pipe(Effect.mapError(toError)),
});

const createBoundLocalToolRuntimeLoader = (
  context: ResolvedLocalWorkspaceContext,
  fileSystem: FileSystem.FileSystem,
): ExecutorWorkspaceLocalToolRepository => ({
  load: () =>
    bindFileSystem(fileSystem, loadLocalToolRuntime(context)),
});

const createBoundSourceTypeDeclarationsRefresher = (
  context: ResolvedLocalWorkspaceContext,
): ExecutorWorkspaceSourceTypeDeclarationsRepository => ({
  refreshWorkspaceInBackground: ({ entries }) =>
    Effect.sync(() => {
      refreshWorkspaceSourceTypeDeclarationsInBackground({
        context,
        entries,
      });
    }),
  refreshSourceInBackground: ({ source, snapshot }) =>
    Effect.sync(() => {
      refreshSourceTypeDeclarationInBackground({
        context,
        source,
        snapshot,
      });
    }),
});

const toExecutorScopeContext = (
  context: ResolvedLocalWorkspaceContext,
): ExecutorScopeDescriptor => ({
  scopeName: context.workspaceName,
  scopeRoot: context.workspaceRoot,
  metadata: {
    kind: "file",
    configDirectory: context.configDirectory,
    projectConfigPath: context.projectConfigPath,
    homeConfigPath: context.homeConfigPath,
    homeStateDirectory: context.homeStateDirectory,
    artifactsDirectory: context.artifactsDirectory,
    stateDirectory: context.stateDirectory,
  },
});

export const createLocalExecutorRepositoriesEffect = (
  options: CreateLocalExecutorBackendOptions = {},
  runtimeOptions: ExecutorRuntimeOptions = {},
): Effect.Effect<ExecutorBackendRepositories, Error> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceContext = yield* bindFileSystem(
      fileSystem,
      resolveLocalWorkspaceContext({
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot,
        homeConfigPath: options.homeConfigPath,
        homeStateDirectory: options.homeStateDirectory,
      }),
    ).pipe(Effect.mapError(toError));

    const executorStateStorage = createLocalExecutorStatePersistence(
      workspaceContext,
      fileSystem,
    );
    const workspaceConfigStore = createBoundWorkspaceConfigStore(
      workspaceContext,
      fileSystem,
    );
    const loadedConfig = yield* workspaceConfigStore.load();
    const pluginRegistry = runtimeOptions.pluginRegistry ?? emptyExecutorPluginRegistry();
    yield* provisionBuiltinSecretStores({
      executorState: executorStateStorage.executorState,
      pluginRegistry,
      scopeId: deriveLocalInstallation(workspaceContext).scopeId,
    });
    const resolveSecretMaterial: ResolveSecretMaterial =
      runtimeOptions.resolveSecretMaterial
      ?? createDefaultSecretMaterialResolver({
        executorState: executorStateStorage.executorState,
        pluginRegistry,
      });

    return {
      scope: toExecutorScopeContext(workspaceContext),
      installation: createBoundInstallationStore(workspaceContext),
      workspace: {
        config: workspaceConfigStore,
        state: createBoundWorkspaceStateStore(
          workspaceContext,
          fileSystem,
        ),
        sourceArtifacts: createBoundSourceArtifactStore(
          workspaceContext,
          fileSystem,
        ),
        localTools: createBoundLocalToolRuntimeLoader(
          workspaceContext,
          fileSystem,
        ),
        sourceTypeDeclarations:
          createBoundSourceTypeDeclarationsRefresher(workspaceContext),
      },
      secrets: {
        secretStores: executorStateStorage.executorState.secretStores,
        secretMaterialStoredData:
          executorStateStorage.executorState.secretMaterialStoredData,
        ...executorStateStorage.executorState.secretMaterials,
        resolve: resolveSecretMaterial,
        store: createDefaultSecretMaterialStorer({
          executorState: executorStateStorage.executorState,
          pluginRegistry,
          resolveSecretMaterial,
        }),
        delete: createDefaultSecretMaterialDeleter({
          executorState: executorStateStorage.executorState,
          pluginRegistry,
          resolveSecretMaterial,
        }),
        update: createDefaultSecretMaterialUpdater({
          executorState: executorStateStorage.executorState,
          pluginRegistry,
          resolveSecretMaterial,
        }),
      },
      executions: {
        runs: executorStateStorage.executorState.executions,
        interactions:
          executorStateStorage.executorState.executionInteractions,
        steps: executorStateStorage.executorState.executionSteps,
      },
      instanceConfig: {
        resolve: createLocalInstanceConfigResolver({
          executorState: executorStateStorage.executorState,
          pluginRegistry,
        }),
      },
      close: executorStateStorage.close,
    } satisfies ExecutorBackendRepositories;
  }).pipe(Effect.provide(NodeFileSystem.layer));

export const createLocalExecutorBackend = (
  options: CreateLocalExecutorBackendOptions = {},
): ExecutorBackend =>
  createExecutorBackend({
    loadRepositories: (runtimeOptions: ExecutorRuntimeOptions) =>
      createLocalExecutorRepositoriesEffect(options, runtimeOptions),
  });

export const createLocalExecutorRuntime = (
  options: CreateLocalRuntimeOptions = {},
): Effect.Effect<ExecutorRuntime, Error> =>
  createLocalExecutorBackend(options).createRuntime({
    executionResolver: options.executionResolver,
    resolveSecretMaterial: options.resolveSecretMaterial,
    getLocalServerBaseUrl: options.getLocalServerBaseUrl,
  });

type CreateLocalExecutorOptions<
  TPlugins extends readonly ExecutorSdkPlugin<any, any>[] = [],
> = CreateLocalExecutorBackendOptions & ExecutorRuntimeOptions & {
  plugins?: TPlugins;
};

export const createLocalExecutorEffect = <
  const TPlugins extends readonly ExecutorSdkPlugin<any, any>[] = [],
>(
  options: CreateLocalExecutorOptions<TPlugins> = {},
): Effect.Effect<
  ExecutorEffect & ExecutorSdkPluginExtensions<TPlugins>,
  Error
> => {
  return createExecutorEffect({
    backend: createLocalExecutorBackend(options),
    plugins: (options.plugins ?? []) as TPlugins,
    executionResolver: options.executionResolver,
    resolveSecretMaterial: options.resolveSecretMaterial,
    getLocalServerBaseUrl: options.getLocalServerBaseUrl,
  }) as Effect.Effect<
    ExecutorEffect & ExecutorSdkPluginExtensions<TPlugins>,
    Error
  >;
};

export const createLocalExecutor = <
  const TPlugins extends readonly ExecutorSdkPlugin<any, any>[] = [],
>(
  options: CreateLocalExecutorOptions<TPlugins> = {},
) => {
  return createExecutor({
    backend: createLocalExecutorBackend(options),
    plugins: (options.plugins ?? []) as TPlugins,
    executionResolver: options.executionResolver,
    resolveSecretMaterial: options.resolveSecretMaterial,
    getLocalServerBaseUrl: options.getLocalServerBaseUrl,
  }) as Promise<Executor<TPlugins>>;
};

export {
  deriveLocalInstallation,
  getOrProvisionLocalInstallation,
  loadLocalInstallation,
} from "./installation";
export {
  loadLocalExecutorStateSnapshot,
  writeLocalExecutorStateSnapshot,
} from "./executor-state-store";
export {
  loadLocalExecutorConfig,
  resolveConfigRelativePath,
  resolveLocalWorkspaceContext,
  writeProjectLocalExecutorConfig,
} from "./config";
export {
  loadLocalWorkspaceState,
  writeLocalWorkspaceState,
} from "./workspace-state";
export {
  buildLocalSourceArtifact,
  readLocalSourceArtifact,
  removeLocalSourceArtifact,
  writeLocalSourceArtifact,
} from "./source-artifacts";
export {
  refreshSourceTypeDeclarationInBackground,
  refreshWorkspaceSourceTypeDeclarationsInBackground,
  syncSourceTypeDeclarationNode,
  syncWorkspaceSourceTypeDeclarationsNode,
} from "./source-type-declarations";
export type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "./config";
