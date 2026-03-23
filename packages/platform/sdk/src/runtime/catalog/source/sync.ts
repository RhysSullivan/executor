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
  RuntimeSourceAuthMaterialService,
} from "../../auth/source-auth-material";
import {
  getSourceAdapterForSource,
} from "../../sources/source-adapters";
import {
  SecretMaterialResolverService,
} from "../../scope/secret-material-providers";
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
  && source.status === "connected"
  && getSourceAdapterForSource(source).catalogKind !== "internal";

type RuntimeSourceCatalogSyncDeps = {
  runtimeLocalScope: RuntimeLocalScopeState;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  sourceTypeDeclarationsRefresher: SourceTypeDeclarationsRefresherShape;
  resolveSecretMaterial: Effect.Effect.Success<typeof SecretMaterialResolverService>;
  sourceAuthMaterialService: Effect.Effect.Success<typeof RuntimeSourceAuthMaterialService>;
};

type SourceCatalogSyncServices =
  | RuntimeLocalScopeService
  | ScopeStateStore
  | SourceArtifactStore
  | SourceTypeDeclarationsRefresherService
  | RuntimeSourceAuthMaterialService
  | SecretMaterialResolverService;

export type RuntimeSourceCatalogSyncShape = {
  sync: (input: {
    source: Source;
    actorScopeId?: ScopeId | null;
  }) => Effect.Effect<void, Error, never>;
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
    return yield* Effect.fail(
      runtimeEffectError("catalog/source/sync", 
        `Runtime local scope mismatch: expected ${scopeId}, got ${deps.runtimeLocalScope.installation.scopeId}`,
      ),
    );
  }
  });

const syncSourceCatalogWithDeps = (
  deps: RuntimeSourceCatalogSyncDeps,
  input: {
    source: Source;
    actorScopeId?: ScopeId | null;
  },
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    yield* ensureRuntimeCatalogSyncWorkspace(deps, input.source.scopeId);

    if (!shouldIndexSource(input.source)) {
      const state = yield* deps.scopeStateStore.load();
      const existingSourceState = state.sources[input.source.id];
      const nextState: LocalScopeState = {
        ...state,
        sources: {
          ...state.sources,
          [input.source.id]: {
            status: (input.source.enabled ? input.source.status : "draft") as SourceStatus,
            lastError: null,
            sourceHash: input.source.sourceHash,
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

    const adapter = getSourceAdapterForSource(input.source);
    const syncResult = yield* adapter.syncCatalog({
      source: input.source,
      resolveSecretMaterial: deps.resolveSecretMaterial,
      resolveAuthMaterialForSlot: (slot) =>
        deps.sourceAuthMaterialService.resolve({
          source: input.source,
          slot,
          actorScopeId: input.actorScopeId,
        }),
    });
    const snapshot = snapshotFromSourceCatalogSyncResult(syncResult);
    yield* deps.sourceArtifactStore.write({
      sourceId: input.source.id,
      artifact: deps.sourceArtifactStore.build({
        source: input.source,
        syncResult,
      }),
    });

    const state = yield* deps.scopeStateStore.load();
    const existingSourceState = state.sources[input.source.id];
    const nextState: LocalScopeState = {
      ...state,
      sources: {
        ...state.sources,
        [input.source.id]: {
          status: "connected",
          lastError: null,
          sourceHash: syncResult.sourceHash,
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
        "executor.source.endpoint": input.source.endpoint,
      },
    }),
  );

export const syncSourceCatalog = (input: {
  source: Source;
  actorScopeId?: ScopeId | null;
}): Effect.Effect<void, Error, SourceCatalogSyncServices> =>
  Effect.gen(function* () {
    const runtimeLocalScope = yield* RuntimeLocalScopeService;
    const scopeStateStore = yield* ScopeStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    return yield* syncSourceCatalogWithDeps(
      {
        runtimeLocalScope,
        scopeStateStore,
        sourceArtifactStore,
        sourceTypeDeclarationsRefresher,
        resolveSecretMaterial,
        sourceAuthMaterialService,
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
    const scopeStateStore = yield* ScopeStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    const deps: RuntimeSourceCatalogSyncDeps = {
      runtimeLocalScope,
      scopeStateStore,
      sourceArtifactStore,
      sourceTypeDeclarationsRefresher,
      resolveSecretMaterial,
      sourceAuthMaterialService,
    };

    return RuntimeSourceCatalogSyncService.of({
      sync: (input) => syncSourceCatalogWithDeps(deps, input),
    });
  }),
);
