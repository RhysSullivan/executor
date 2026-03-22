import type {
  AccountId,
  Source,
  WorkspaceId,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SourceTypeDeclarationsRefresherService } from "../catalog/source/type-declarations";
import {
  SourceArtifactStore,
  type WorkspaceStorageServices,
  WorkspaceConfigStore,
  WorkspaceStateStore,
} from "../workspace/storage";
import { SecretMaterialDeleterService } from "../workspace/secret-material-providers";
import { RuntimeLocalWorkspaceService } from "../workspace/runtime-context";
import { ExecutorStateStore, type ExecutorStateStoreShape } from "../executor-state-store";
import {
  loadRuntimeSourceStoreDeps,
  type RuntimeSourceStoreDeps,
} from "./source-store/deps";
import {
  buildLocalSourceRecord,
  listLinkedSecretSourcesInWorkspaceWithDeps,
  loadSourceByIdWithDeps,
  loadSourcesInWorkspaceWithDeps,
} from "./source-store/records";
import {
  persistSourceWithDeps,
  removeSourceByIdWithDeps,
} from "./source-store/lifecycle";

export { buildLocalSourceRecord } from "./source-store/records";

type RuntimeSourceStoreShape = {
  loadSourcesInWorkspace: (
    workspaceId: WorkspaceId,
    options?: { actorAccountId?: AccountId | null },
  ) => ReturnType<typeof loadSourcesInWorkspaceWithDeps>;
  listLinkedSecretSourcesInWorkspace: (
    workspaceId: WorkspaceId,
    options?: { actorAccountId?: AccountId | null },
  ) => ReturnType<typeof listLinkedSecretSourcesInWorkspaceWithDeps>;
  loadSourceById: (input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  }) => ReturnType<typeof loadSourceByIdWithDeps>;
  removeSourceById: (input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
  }) => ReturnType<typeof removeSourceByIdWithDeps>;
  persistSource: (
    source: Source,
    options?: { actorAccountId?: AccountId | null },
  ) => ReturnType<typeof persistSourceWithDeps>;
};

export type RuntimeSourceStore = RuntimeSourceStoreShape;

export const loadSourcesInWorkspace = (
  executorState: ExecutorStateStoreShape,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<
  readonly Source[],
  Error,
  WorkspaceStorageServices | SourceTypeDeclarationsRefresherService
> =>
  Effect.flatMap(
    loadRuntimeSourceStoreDeps(executorState, workspaceId),
    (deps) => loadSourcesInWorkspaceWithDeps(deps, workspaceId, options),
  );

export const listLinkedSecretSourcesInWorkspace = (
  executorState: ExecutorStateStoreShape,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<
  Map<string, Array<{ sourceId: string; sourceName: string }>>,
  Error,
  WorkspaceStorageServices | SourceTypeDeclarationsRefresherService
> =>
  Effect.flatMap(
    loadRuntimeSourceStoreDeps(executorState, workspaceId),
    (deps) => listLinkedSecretSourcesInWorkspaceWithDeps(deps, workspaceId, options),
  );

export const loadSourceById = (
  executorState: ExecutorStateStoreShape,
  input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  },
): Effect.Effect<
  Source,
  Error,
  WorkspaceStorageServices | SourceTypeDeclarationsRefresherService
> =>
  Effect.flatMap(
    loadRuntimeSourceStoreDeps(executorState, input.workspaceId),
    (deps) => loadSourceByIdWithDeps(deps, input),
  );

export const removeSourceById = (
  executorState: ExecutorStateStoreShape,
  input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
  },
): Effect.Effect<
  boolean,
  Error,
  | WorkspaceStorageServices
  | SourceTypeDeclarationsRefresherService
  | SecretMaterialDeleterService
> =>
  Effect.gen(function* () {
    const deps = yield* loadRuntimeSourceStoreDeps(executorState, input.workspaceId);
    const deleteSecretMaterial = yield* SecretMaterialDeleterService;
    return yield* removeSourceByIdWithDeps(deps, input, deleteSecretMaterial);
  });

export const persistSource = (
  executorState: ExecutorStateStoreShape,
  source: Source,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<
  Source,
  Error,
  | WorkspaceStorageServices
  | SourceTypeDeclarationsRefresherService
  | SecretMaterialDeleterService
> =>
  Effect.gen(function* () {
    const deps = yield* loadRuntimeSourceStoreDeps(executorState, source.workspaceId);
    const deleteSecretMaterial = yield* SecretMaterialDeleterService;
    return yield* persistSourceWithDeps(deps, source, options, deleteSecretMaterial);
  });

export class RuntimeSourceStoreService extends Context.Tag(
  "#runtime/RuntimeSourceStoreService",
)<RuntimeSourceStoreService, RuntimeSourceStoreShape>() {}

export const RuntimeSourceStoreLive = Layer.effect(
  RuntimeSourceStoreService,
  Effect.gen(function* () {
    const executorState = yield* ExecutorStateStore;
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const workspaceConfigStore = yield* WorkspaceConfigStore;
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;
    const deleteSecretMaterial = yield* SecretMaterialDeleterService;

    const deps: RuntimeSourceStoreDeps = {
      executorState,
      runtimeLocalWorkspace,
      workspaceConfigStore,
      workspaceStateStore,
      sourceArtifactStore,
      sourceTypeDeclarationsRefresher,
    };

    return RuntimeSourceStoreService.of({
      loadSourcesInWorkspace: (workspaceId, options = {}) =>
        loadSourcesInWorkspaceWithDeps(deps, workspaceId, options),
      listLinkedSecretSourcesInWorkspace: (workspaceId, options = {}) =>
        listLinkedSecretSourcesInWorkspaceWithDeps(deps, workspaceId, options),
      loadSourceById: (input) =>
        loadSourceByIdWithDeps(deps, input),
      removeSourceById: (input) =>
        removeSourceByIdWithDeps(deps, input, deleteSecretMaterial),
      persistSource: (source, options = {}) =>
        persistSourceWithDeps(deps, source, options, deleteSecretMaterial),
    });
  }),
);
