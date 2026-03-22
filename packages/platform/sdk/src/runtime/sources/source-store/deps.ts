import type { AccountId, WorkspaceId } from "#schema";
import * as Effect from "effect/Effect";

import type { LoadedLocalExecutorConfig } from "../../workspace-config";
import {
  SourceTypeDeclarationsRefresherService,
  type SourceTypeDeclarationsRefresherShape,
} from "../../catalog/source/type-declarations";
import {
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "../../workspace-errors";
import {
  requireRuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState,
} from "../../workspace/runtime-context";
import type {
  SourceArtifactStoreShape,
  WorkspaceStorageServices,
  WorkspaceConfigStoreShape,
  WorkspaceStateStoreShape,
} from "../../workspace/storage";
import {
  SourceArtifactStore,
  WorkspaceConfigStore,
  WorkspaceStateStore,
} from "../../workspace/storage";
import type { LocalWorkspaceState } from "../../workspace-state";
import type { ExecutorStateStoreShape } from "../../executor-state-store";

export type RuntimeSourceStoreDeps = {
  executorState: ExecutorStateStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  sourceTypeDeclarationsRefresher: SourceTypeDeclarationsRefresherShape;
};

export type ResolvedSourceStoreWorkspace = {
  installation: {
    workspaceId: WorkspaceId;
    accountId: AccountId;
  };
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  loadedConfig: LoadedLocalExecutorConfig;
  workspaceState: LocalWorkspaceState;
};

export type RuntimeSourceStoreServices =
  WorkspaceStorageServices | SourceTypeDeclarationsRefresherService;

export const resolveRuntimeLocalWorkspaceFromDeps = (
  deps: RuntimeSourceStoreDeps,
  workspaceId: WorkspaceId,
): Effect.Effect<
  ResolvedSourceStoreWorkspace,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | Error,
  never
> =>
  Effect.gen(function* () {
    if (deps.runtimeLocalWorkspace.installation.workspaceId !== workspaceId) {
      return yield* new RuntimeLocalWorkspaceMismatchError({
          message: `Runtime local workspace mismatch: expected ${workspaceId}, got ${deps.runtimeLocalWorkspace.installation.workspaceId}`,
          requestedWorkspaceId: workspaceId,
          activeWorkspaceId: deps.runtimeLocalWorkspace.installation.workspaceId,
        });
    }

    const loadedConfig = yield* deps.workspaceConfigStore.load();
    const workspaceState = yield* deps.workspaceStateStore.load();

    return {
      installation: deps.runtimeLocalWorkspace.installation,
      workspaceConfigStore: deps.workspaceConfigStore,
      workspaceStateStore: deps.workspaceStateStore,
      sourceArtifactStore: deps.sourceArtifactStore,
      loadedConfig,
      workspaceState,
    };
  });

export const loadRuntimeSourceStoreDeps = (
  executorState: ExecutorStateStoreShape,
  workspaceId: WorkspaceId,
): Effect.Effect<
  RuntimeSourceStoreDeps,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | Error,
  RuntimeSourceStoreServices
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace(workspaceId);
    const workspaceConfigStore = yield* WorkspaceConfigStore;
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;

    return {
      executorState,
      runtimeLocalWorkspace,
      workspaceConfigStore,
      workspaceStateStore,
      sourceArtifactStore,
      sourceTypeDeclarationsRefresher,
    };
  });
