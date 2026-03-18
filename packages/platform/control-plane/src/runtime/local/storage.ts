import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type { LocalInstallation, LocalExecutorConfig } from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "./config";
import {
  loadLocalExecutorConfig,
  resolveConfigRelativePath,
  writeProjectLocalExecutorConfig,
} from "./config";
import {
  getOrProvisionLocalInstallation,
  loadLocalInstallation,
} from "./installation";
import type {
  LocalSourceArtifact,
} from "./source-artifacts";
import {
  buildLocalSourceArtifact,
  readLocalSourceArtifact,
  removeLocalSourceArtifact,
  writeLocalSourceArtifact,
} from "./source-artifacts";
import type { LocalWorkspaceState } from "./workspace-state";
import {
  loadLocalWorkspaceState,
  writeLocalWorkspaceState,
} from "./workspace-state";
import type { SourceCatalogSyncResult } from "@executor/source-core";
import type { Source } from "#schema";

export type InstallationStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LocalInstallation, never, never>;
  getOrProvision: (input: {
    context: ResolvedLocalWorkspaceContext;
  }) => Effect.Effect<LocalInstallation, never, never>;
};

export class InstallationStore extends Context.Tag(
  "#runtime/InstallationStore",
)<InstallationStore, InstallationStoreShape>() {}

export type WorkspaceConfigStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LoadedLocalExecutorConfig, Error, never>;
  writeProject: (input: {
    context: ResolvedLocalWorkspaceContext;
    config: LocalExecutorConfig;
  }) => Effect.Effect<void, Error, never>;
  resolveRelativePath: (input: { path: string; workspaceRoot: string }) => string;
};

export class WorkspaceConfigStore extends Context.Tag(
  "#runtime/WorkspaceConfigStore",
)<WorkspaceConfigStore, WorkspaceConfigStoreShape>() {}

export type WorkspaceStateStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LocalWorkspaceState, Error, never>;
  write: (input: {
    context: ResolvedLocalWorkspaceContext;
    state: LocalWorkspaceState;
  }) => Effect.Effect<void, Error, never>;
};

export class WorkspaceStateStore extends Context.Tag(
  "#runtime/WorkspaceStateStore",
)<WorkspaceStateStore, WorkspaceStateStoreShape>() {}

export type SourceArtifactStoreShape = {
  build: (input: {
    source: Source;
    syncResult: SourceCatalogSyncResult;
  }) => LocalSourceArtifact;
  read: (input: {
    context: ResolvedLocalWorkspaceContext;
    sourceId: string;
  }) => Effect.Effect<LocalSourceArtifact | null, Error, never>;
  write: (input: {
    context: ResolvedLocalWorkspaceContext;
    sourceId: string;
    artifact: LocalSourceArtifact;
  }) => Effect.Effect<void, Error, never>;
  remove: (input: {
    context: ResolvedLocalWorkspaceContext;
    sourceId: string;
  }) => Effect.Effect<void, Error, never>;
};

export class SourceArtifactStore extends Context.Tag(
  "#runtime/SourceArtifactStore",
)<SourceArtifactStore, SourceArtifactStoreShape>() {}

export type LocalStorageServices =
  | InstallationStore
  | WorkspaceConfigStore
  | WorkspaceStateStore
  | SourceArtifactStore;

export type WorkspaceStorageServices =
  | WorkspaceConfigStore
  | WorkspaceStateStore
  | SourceArtifactStore;

export const LocalInstallationStore: InstallationStoreShape = {
  load: loadLocalInstallation,
  getOrProvision: getOrProvisionLocalInstallation,
};

export const LocalInstallationStoreLive = Layer.succeed(
  InstallationStore,
  LocalInstallationStore,
);

const bindFileSystem = <A, E>(
  fileSystem: FileSystem.FileSystem,
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

const bindNodeFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(NodeFileSystem.layer));

export const LocalWorkspaceConfigStore: WorkspaceConfigStoreShape = {
  load: (context) => bindNodeFileSystem(loadLocalExecutorConfig(context)),
  writeProject: (input) => bindNodeFileSystem(writeProjectLocalExecutorConfig(input)),
  resolveRelativePath: resolveConfigRelativePath,
};

export const LocalWorkspaceConfigStoreLive = Layer.effect(
  WorkspaceConfigStore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return WorkspaceConfigStore.of({
      load: (context) => bindFileSystem(fileSystem, loadLocalExecutorConfig(context)),
      writeProject: (input) =>
        bindFileSystem(fileSystem, writeProjectLocalExecutorConfig(input)),
      resolveRelativePath: resolveConfigRelativePath,
    });
  }),
);

export const LocalWorkspaceStateStore: WorkspaceStateStoreShape = {
  load: (context) => bindNodeFileSystem(loadLocalWorkspaceState(context)),
  write: (input) => bindNodeFileSystem(writeLocalWorkspaceState(input)),
};

export const LocalWorkspaceStateStoreLive = Layer.effect(
  WorkspaceStateStore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return WorkspaceStateStore.of({
      load: (context) => bindFileSystem(fileSystem, loadLocalWorkspaceState(context)),
      write: (input) => bindFileSystem(fileSystem, writeLocalWorkspaceState(input)),
    });
  }),
);

export const LocalSourceArtifactStore: SourceArtifactStoreShape = {
  build: buildLocalSourceArtifact,
  read: (input) => bindNodeFileSystem(readLocalSourceArtifact(input)),
  write: (input) => bindNodeFileSystem(writeLocalSourceArtifact(input)),
  remove: (input) => bindNodeFileSystem(removeLocalSourceArtifact(input)),
};

export const LocalSourceArtifactStoreLive = Layer.effect(
  SourceArtifactStore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return SourceArtifactStore.of({
      build: buildLocalSourceArtifact,
      read: (input) => bindFileSystem(fileSystem, readLocalSourceArtifact(input)),
      write: (input) => bindFileSystem(fileSystem, writeLocalSourceArtifact(input)),
      remove: (input) => bindFileSystem(fileSystem, removeLocalSourceArtifact(input)),
    });
  }),
);

export const makeWorkspaceStorageLayer = (input: {
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
}) =>
  Layer.mergeAll(
    Layer.succeed(WorkspaceConfigStore, input.workspaceConfigStore),
    Layer.succeed(WorkspaceStateStore, input.workspaceStateStore),
    Layer.succeed(SourceArtifactStore, input.sourceArtifactStore),
  );

export const makeLocalStorageLayer = (input: {
  installationStore: InstallationStoreShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
}) =>
  Layer.mergeAll(
    Layer.succeed(InstallationStore, input.installationStore),
    makeWorkspaceStorageLayer(input),
  );

export const WorkspaceStorageLive = Layer.mergeAll(
  LocalWorkspaceConfigStoreLive,
  LocalWorkspaceStateStoreLive,
  LocalSourceArtifactStoreLive,
);

export const LocalStorageLive = Layer.mergeAll(
  LocalInstallationStoreLive,
  WorkspaceStorageLive,
);
