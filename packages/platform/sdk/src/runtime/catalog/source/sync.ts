import type {
  ScopeId,
  Source,
  SourceStatus,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  RuntimeLocalScopeService,
  type RuntimeLocalScopeState,
} from "../../scope/runtime-context";
import {
  SourceArtifactStore,
  type SourceArtifactStoreShape,
  ScopeStateStore,
  type ScopeStateStoreShape,
} from "../../scope/storage";
import {
  type LocalScopeState,
} from "../../scope-state";
import {
  getSourceContributionForSource,
  ExecutorPluginRegistryService,
} from "../../sources/source-plugins";
import {
  snapshotFromSourceCatalogSyncResult,
} from "@executor/source-core";
import {
  SourceTypeDeclarationsRefresherService,
  type SourceTypeDeclarationsRefresherShape,
} from "./type-declarations";
import {
  runtimeEffectError,
} from "../../effect-errors";

const shouldIndexSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected";

type RuntimeSourceCatalogSyncDeps = {
  pluginRegistry: Effect.Effect.Success<typeof ExecutorPluginRegistryService>;
  runtimeLocalScope: RuntimeLocalScopeState;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  sourceTypeDeclarationsRefresher: SourceTypeDeclarationsRefresherShape;
};

type SourceCatalogSyncServices =
  | ExecutorPluginRegistryService
  | RuntimeLocalScopeService
  | ScopeStateStore
  | SourceArtifactStore
  | SourceTypeDeclarationsRefresherService;

export type RuntimeSourceCatalogSyncShape = {
  sync: (input: {
    source: Source;
    actorScopeId?: ScopeId | null;
  }) => Effect.Effect<void, Error, any>;
};

export class RuntimeSourceCatalogSyncService extends Context.Tag(
  "#runtime/RuntimeSourceCatalogSyncService",
)<RuntimeSourceCatalogSyncService, RuntimeSourceCatalogSyncShape>() {}

const ensureRuntimeCatalogSyncWorkspace = (
  deps: RuntimeSourceCatalogSyncDeps,
  scopeId: Source["scopeId"],
) =>
  Effect.gen(function* () {
    if (deps.runtimeLocalScope.installation.scopeId !== scopeId) {
      return yield* runtimeEffectError(
        "catalog/source/sync",
        `Runtime local scope mismatch: expected ${scopeId}, got ${deps.runtimeLocalScope.installation.scopeId}`,
      );
    }
  });

const syncSourceCatalogWithDeps = (
  deps: RuntimeSourceCatalogSyncDeps,
  input: {
    source: Source;
    actorScopeId?: ScopeId | null;
  },
): Effect.Effect<void, Error, any> =>
  Effect.gen(function* () {
    yield* ensureRuntimeCatalogSyncWorkspace(deps, input.source.scopeId);

    if (!shouldIndexSource(input.source)) {
      const state = yield* deps.scopeStateStore.load();
      const existingSourceState =
        state.sources[input.source.id] as LocalScopeState["sources"][string] | undefined;
      const nextState: LocalScopeState = {
        ...state,
        sources: {
          ...state.sources,
          [input.source.id]: {
            status: (input.source.enabled ? input.source.status : "draft") as SourceStatus,
            lastError: null,
            sourceHash: existingSourceState?.sourceHash ?? null,
            createdAt: existingSourceState?.createdAt ?? input.source.createdAt,
            updatedAt: Date.now(),
          },
        },
      };
      yield* deps.scopeStateStore.write({
        state: nextState,
      });
      yield* deps.sourceTypeDeclarationsRefresher.refreshSourceInBackground({
        source: input.source,
        snapshot: null,
      });
      return;
    }

    const definition = getSourceContributionForSource(
      deps.pluginRegistry,
      input.source,
    );
    const irModel = yield* definition.syncCatalog({
      source: input.source,
    });
    const snapshot = snapshotFromSourceCatalogSyncResult(irModel);
    yield* deps.sourceArtifactStore.write({
      sourceId: input.source.id,
      artifact: deps.sourceArtifactStore.build({
        source: input.source,
        syncResult: irModel,
      }),
    });

    const state = yield* deps.scopeStateStore.load();
    const existingSourceState =
      state.sources[input.source.id] as LocalScopeState["sources"][string] | undefined;
    const nextState: LocalScopeState = {
      ...state,
      sources: {
        ...state.sources,
        [input.source.id]: {
          status: "connected",
          lastError: null,
          sourceHash: irModel.sourceHash,
          createdAt: existingSourceState?.createdAt ?? input.source.createdAt,
          updatedAt: Date.now(),
        },
      },
    };
    yield* deps.scopeStateStore.write({
      state: nextState,
    });

    yield* deps.sourceTypeDeclarationsRefresher.refreshSourceInBackground({
      source: input.source,
      snapshot,
    });
  }).pipe(
    Effect.withSpan("source.catalog.sync", {
      attributes: {
        "executor.source.id": input.source.id,
        "executor.source.kind": input.source.kind,
        "executor.source.namespace": input.source.namespace,
      },
    }),
  );

export const syncSourceCatalog = (input: {
  source: Source;
  actorScopeId?: ScopeId | null;
}): Effect.Effect<void, Error, SourceCatalogSyncServices> =>
  Effect.gen(function* () {
    const runtimeLocalScope = yield* RuntimeLocalScopeService;
    const pluginRegistry = yield* ExecutorPluginRegistryService;
    const scopeStateStore = yield* ScopeStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;
    return yield* syncSourceCatalogWithDeps(
      {
        pluginRegistry,
        runtimeLocalScope,
        scopeStateStore,
        sourceArtifactStore,
        sourceTypeDeclarationsRefresher,
      },
      {
        source: input.source,
        actorScopeId: input.actorScopeId,
      },
    );
  });

export const RuntimeSourceCatalogSyncLive = Layer.effect(
  RuntimeSourceCatalogSyncService,
  Effect.gen(function* () {
    const runtimeLocalScope = yield* RuntimeLocalScopeService;
    const pluginRegistry = yield* ExecutorPluginRegistryService;
    const scopeStateStore = yield* ScopeStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;
    const deps: RuntimeSourceCatalogSyncDeps = {
      pluginRegistry,
      runtimeLocalScope,
      scopeStateStore,
      sourceArtifactStore,
      sourceTypeDeclarationsRefresher,
    };

    return RuntimeSourceCatalogSyncService.of({
      sync: (input) => syncSourceCatalogWithDeps(deps, input),
    });
  }),
);
