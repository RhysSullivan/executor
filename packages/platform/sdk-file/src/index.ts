import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  createExecutor,
  createExecutorBackend,
  createExecutorEffect,
  type CreateExecutorOptions,
  type Executor,
  type ExecutorBackend,
  type ExecutorBackendServices,
  type ExecutorLocalToolBackend,
  type ExecutorSourceTypeDeclarationsBackend,
  type ExecutorWorkspaceDescriptor,
} from "@executor/platform-sdk";
import type {
  LocalExecutorConfig,
  LocalInstallation,
} from "@executor/platform-sdk/schema";
import {
  type ExecutorRuntime,
  type ExecutorRuntimeOptions,
  type ResolveSecretMaterial,
} from "@executor/platform-sdk/runtime";
import * as Effect from "effect/Effect";
import type { LocalToolRuntime } from "../../sdk/src/runtime/local-tool-runtime";
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
} from "./secret-material-providers";
import {
  buildLocalSourceArtifact,
  readLocalSourceArtifact,
  removeLocalSourceArtifact,
  writeLocalSourceArtifact,
} from "./source-artifacts";
import {
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
): ExecutorLocalToolBackend => ({
  load: () =>
    bindFileSystem(fileSystem, loadLocalToolRuntime(context)),
});

const createBoundSourceTypeDeclarationsRefresher = (
  context: ResolvedLocalWorkspaceContext,
): ExecutorSourceTypeDeclarationsBackend => ({
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

const toExecutorWorkspaceContext = (
  context: ResolvedLocalWorkspaceContext,
): ExecutorWorkspaceDescriptor => ({
  workspaceName: context.workspaceName,
  workspaceRoot: context.workspaceRoot,
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

export const createLocalExecutorServicesEffect = (
  options: CreateLocalExecutorBackendOptions = {},
  runtimeOptions: ExecutorRuntimeOptions = {},
): Effect.Effect<ExecutorBackendServices, Error> =>
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
    const resolveSecretMaterial: ResolveSecretMaterial =
      runtimeOptions.resolveSecretMaterial
      ?? createDefaultSecretMaterialResolver({
        executorState: executorStateStorage.executorState,
        localConfig: loadedConfig.config,
        workspaceRoot: workspaceContext.workspaceRoot,
      });

    return {
      workspace: toExecutorWorkspaceContext(workspaceContext),
      storage: {
        installation: createBoundInstallationStore(workspaceContext),
        workspaceConfig: workspaceConfigStore,
        workspaceState: createBoundWorkspaceStateStore(
          workspaceContext,
          fileSystem,
        ),
        sourceArtifacts: createBoundSourceArtifactStore(
          workspaceContext,
          fileSystem,
        ),
        executorState: executorStateStorage.executorState,
        secretMaterial: {
          resolve: resolveSecretMaterial,
          store: createDefaultSecretMaterialStorer({
            executorState: executorStateStorage.executorState,
          }),
          delete: createDefaultSecretMaterialDeleter({
            executorState: executorStateStorage.executorState,
          }),
          update: createDefaultSecretMaterialUpdater({
            executorState: executorStateStorage.executorState,
          }),
        },
        close: executorStateStorage.close,
      },
      localTools: createBoundLocalToolRuntimeLoader(
        workspaceContext,
        fileSystem,
      ),
      sourceTypeDeclarations:
        createBoundSourceTypeDeclarationsRefresher(workspaceContext),
      instanceConfig: {
        resolve: createLocalInstanceConfigResolver(),
      },
    } satisfies ExecutorBackendServices;
  }).pipe(Effect.provide(NodeFileSystem.layer));

export const createLocalExecutorBackend = (
  options: CreateLocalExecutorBackendOptions = {},
): ExecutorBackend =>
  createExecutorBackend({
    loadServices: (runtimeOptions: ExecutorRuntimeOptions) =>
      createLocalExecutorServicesEffect(options, runtimeOptions),
  });

export const createLocalExecutorRuntime = (
  options: CreateLocalRuntimeOptions = {},
): Effect.Effect<ExecutorRuntime, Error> =>
  createLocalExecutorBackend(options).createRuntime({
    executionResolver: options.executionResolver,
    createInternalToolMap: options.createInternalToolMap,
    resolveSecretMaterial: options.resolveSecretMaterial,
    getLocalServerBaseUrl: options.getLocalServerBaseUrl,
  });

export const createLocalExecutorEffect = (
  options: CreateLocalExecutorBackendOptions & ExecutorRuntimeOptions = {},
): Effect.Effect<Executor, Error> =>
  createExecutorEffect({
    backend: createLocalExecutorBackend(options),
    executionResolver: options.executionResolver,
    createInternalToolMap: options.createInternalToolMap,
    resolveSecretMaterial: options.resolveSecretMaterial,
    getLocalServerBaseUrl: options.getLocalServerBaseUrl,
  } satisfies CreateExecutorOptions);

export const createLocalExecutor = (
  options: CreateLocalExecutorBackendOptions & ExecutorRuntimeOptions = {},
): Promise<Executor> => Effect.runPromise(createLocalExecutorEffect(options));

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
