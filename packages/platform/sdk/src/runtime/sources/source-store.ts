import type {
  ScopeId,
  Source,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  SourceTypeDeclarationsRefresherService,
} from "../catalog/source/type-declarations";
import {
  SourceArtifactStore,
  type ScopeStorageServices,
  ScopeConfigStore,
  ScopeStateStore,
} from "../scope/storage";
import {
  RuntimeLocalScopeService,
} from "../scope/runtime-context";
import {
  ExecutorStateStore,
  type ExecutorStateStoreShape,
} from "../executor-state-store";
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
  loadSourcesInScope: (
    scopeId: ScopeId,
    options?: { actorScopeId?: ScopeId | null },
  ) => ReturnType<typeof loadSourcesInWorkspaceWithDeps>;
  listLinkedSecretSourcesInScope: (
    scopeId: ScopeId,
    options?: { actorScopeId?: ScopeId | null },
  ) => ReturnType<typeof listLinkedSecretSourcesInWorkspaceWithDeps>;
  loadSourceById: (input: {
    scopeId: ScopeId;
    sourceId: Source["id"];
    actorScopeId?: ScopeId | null;
  }) => ReturnType<typeof loadSourceByIdWithDeps>;
  removeSourceById: (input: {
    scopeId: ScopeId;
    sourceId: Source["id"];
  }) => ReturnType<typeof removeSourceByIdWithDeps>;
  persistSource: (
    source: Source,
    options?: { actorScopeId?: ScopeId | null },
  ) => ReturnType<typeof persistSourceWithDeps>;
};

export type RuntimeSourceStore = RuntimeSourceStoreShape;

export const loadSourcesInScope = (
  executorState: ExecutorStateStoreShape,
  scopeId: ScopeId,
  options: {
    actorScopeId?: ScopeId | null;
  } = {},
): Effect.Effect<
  readonly Source[],
  Error,
  ScopeStorageServices | SourceTypeDeclarationsRefresherService
> =>
  Effect.flatMap(
    loadRuntimeSourceStoreDeps(executorState, scopeId),
    (deps) => loadSourcesInWorkspaceWithDeps(deps, scopeId, options),
  );

export const listLinkedSecretSourcesInScope = (
  executorState: ExecutorStateStoreShape,
  scopeId: ScopeId,
  options: {
    actorScopeId?: ScopeId | null;
  } = {},
): Effect.Effect<
  Map<string, Array<{ sourceId: string; sourceName: string }>>,
  Error,
  ScopeStorageServices | SourceTypeDeclarationsRefresherService
> =>
  Effect.flatMap(
    loadRuntimeSourceStoreDeps(executorState, scopeId),
    (deps) => listLinkedSecretSourcesInWorkspaceWithDeps(deps, scopeId, options),
  );

export const loadSourceById = (
  executorState: ExecutorStateStoreShape,
  input: {
    scopeId: ScopeId;
    sourceId: Source["id"];
    actorScopeId?: ScopeId | null;
  },
): Effect.Effect<
  Source,
  Error,
  ScopeStorageServices | SourceTypeDeclarationsRefresherService
> =>
  Effect.flatMap(
    loadRuntimeSourceStoreDeps(executorState, input.scopeId),
    (deps) => loadSourceByIdWithDeps(deps, input),
  );

export const removeSourceById = (
  executorState: ExecutorStateStoreShape,
  input: {
    scopeId: ScopeId;
    sourceId: Source["id"];
  },
): Effect.Effect<
  boolean,
  Error,
  | ScopeStorageServices
  | SourceTypeDeclarationsRefresherService
> =>
  Effect.flatMap(
    loadRuntimeSourceStoreDeps(executorState, input.scopeId),
    (deps) => removeSourceByIdWithDeps(deps, input),
  );

export const persistSource = (
  executorState: ExecutorStateStoreShape,
  source: Source,
  options: {
    actorScopeId?: ScopeId | null;
  } = {},
): Effect.Effect<
  Source,
  Error,
  | ScopeStorageServices
  | SourceTypeDeclarationsRefresherService
> =>
  Effect.flatMap(
    loadRuntimeSourceStoreDeps(executorState, source.scopeId),
    (deps) => persistSourceWithDeps(deps, source, options),
  );

export class RuntimeSourceStoreService extends Context.Tag(
  "#runtime/RuntimeSourceStoreService",
)<RuntimeSourceStoreService, RuntimeSourceStoreShape>() {}

export const RuntimeSourceStoreLive = Layer.effect(
  RuntimeSourceStoreService,
  Effect.gen(function* () {
    const executorState = yield* ExecutorStateStore;
    const runtimeLocalScope = yield* RuntimeLocalScopeService;
    const scopeConfigStore = yield* ScopeConfigStore;
    const scopeStateStore = yield* ScopeStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;

    const deps: RuntimeSourceStoreDeps = {
      executorState,
      runtimeLocalScope,
      scopeConfigStore,
      scopeStateStore,
      sourceArtifactStore,
      sourceTypeDeclarationsRefresher,
    };

    return RuntimeSourceStoreService.of({
      loadSourcesInScope: (scopeId, options = {}) =>
        loadSourcesInWorkspaceWithDeps(deps, scopeId, options),
      listLinkedSecretSourcesInScope: (scopeId, options = {}) =>
        listLinkedSecretSourcesInWorkspaceWithDeps(deps, scopeId, options),
      loadSourceById: (input) =>
        loadSourceByIdWithDeps(deps, input),
      removeSourceById: (input) =>
        removeSourceByIdWithDeps(deps, input),
      persistSource: (source, options = {}) =>
        persistSourceWithDeps(deps, source, options),
    });
  }),
);
