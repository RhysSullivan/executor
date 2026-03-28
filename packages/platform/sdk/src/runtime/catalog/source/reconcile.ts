import type {
  ScopeId,
  Source,
} from "#schema";
import * as Effect from "effect/Effect";

import {
  RuntimeLocalScopeService,
} from "../../scope/runtime-context";
import {
  SourceArtifactStore,
} from "../../scope/storage";
import {
  RuntimeSourceStoreService,
} from "../../sources/source-store";
import {
  RuntimeSourceCatalogSyncService,
} from "./sync";

const shouldReconcileSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected";

export const reconcileMissingSourceCatalogArtifacts = (input: {
  scopeId: ScopeId;
  actorScopeId?: ScopeId | null;
}): Effect.Effect<
  void,
  Error,
  | RuntimeLocalScopeService
  | SourceArtifactStore
  | RuntimeSourceStoreService
  | RuntimeSourceCatalogSyncService
> =>
  Effect.gen(function* () {
    yield* RuntimeLocalScopeService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceCatalogSync = yield* RuntimeSourceCatalogSyncService;
    const sources = yield* sourceStore.loadSourcesInScope(input.scopeId, {
      actorScopeId: input.actorScopeId,
    });

    for (const source of sources) {
      if (!shouldReconcileSource(source)) {
        continue;
      }

      const artifact = yield* sourceArtifactStore.read({
        sourceId: source.id,
      });
      if (artifact !== null) {
        continue;
      }

      yield* sourceCatalogSync.sync({
        source,
        actorScopeId: input.actorScopeId,
      }).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
  }).pipe(
    Effect.withSpan("source.catalog.reconcile_missing", {
      attributes: {
        "executor.scope.id": input.scopeId,
      },
    }),
  );
