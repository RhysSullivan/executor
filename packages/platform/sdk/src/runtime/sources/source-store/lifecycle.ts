import type {
  ScopeId,
  Source,
} from "#schema";
import * as Effect from "effect/Effect";

import type { LocalScopeState } from "../../scope-state";
import {
  configSourceFromLocalSource,
  cloneJson,
  deriveLocalSourceId,
} from "./config";
import {
  type RuntimeSourceStoreDeps,
  resolveRuntimeLocalScopeFromDeps,
} from "./deps";
import {
  loadSourceByIdWithDeps,
  shouldRefreshScopeDeclarationsAfterPersist,
  syncScopeSourceTypeDeclarationsWithDeps,
} from "./records";

export const removeSourceByIdWithDeps = (
  deps: RuntimeSourceStoreDeps,
  input: {
    scopeId: ScopeId;
    sourceId: Source["id"];
  },
): Effect.Effect<boolean, Error, never> =>
  Effect.gen(function* () {
    const localScope = yield* resolveRuntimeLocalScopeFromDeps(
      deps,
      input.scopeId,
    );
    if (!localScope.loadedConfig.config?.sources?.[input.sourceId]) {
      return false;
    }

    const projectConfig = cloneJson(localScope.loadedConfig.projectConfig ?? {});
    const sources = {
      ...projectConfig.sources,
    };
    delete sources[input.sourceId];
    yield* localScope.scopeConfigStore.writeProject({
      config: {
        ...projectConfig,
        sources,
      },
    });

    const { [input.sourceId]: _removedSource, ...remainingSources } =
      localScope.scopeState.sources;
    const scopeState: LocalScopeState = {
      ...localScope.scopeState,
      sources: remainingSources,
    };
    yield* localScope.scopeStateStore.write({
      state: scopeState,
    });
    yield* localScope.sourceArtifactStore.remove({
      sourceId: input.sourceId,
    });
    yield* syncScopeSourceTypeDeclarationsWithDeps(deps, input.scopeId);

    return true;
  });

export const persistSourceWithDeps = (
  deps: RuntimeSourceStoreDeps,
  source: Source,
  options: {
    actorScopeId?: ScopeId | null;
  } = {},
): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    const localScope = yield* resolveRuntimeLocalScopeFromDeps(
      deps,
      source.scopeId,
    );
    const nextSource = {
      ...source,
      id:
        localScope.loadedConfig.config?.sources?.[source.id] ||
        localScope.scopeState.sources[source.id]
          ? source.id
          : deriveLocalSourceId(
              source,
              new Set(Object.keys(localScope.loadedConfig.config?.sources ?? {})),
            ),
    } satisfies Source;

    const projectConfig = cloneJson(localScope.loadedConfig.projectConfig ?? {});
    const sources = {
      ...projectConfig.sources,
    };
    sources[nextSource.id] = configSourceFromLocalSource({
      source: nextSource,
      existingConfig: localScope.loadedConfig.config?.sources?.[nextSource.id] ?? null,
    });
    yield* localScope.scopeConfigStore.writeProject({
      config: {
        ...projectConfig,
        sources,
      },
    });

    const existingSourceState = localScope.scopeState.sources[nextSource.id];
    const scopeState: LocalScopeState = {
      ...localScope.scopeState,
      sources: {
        ...localScope.scopeState.sources,
        [nextSource.id]: {
          status: nextSource.status,
          lastError: existingSourceState?.lastError ?? null,
          sourceHash: existingSourceState?.sourceHash ?? null,
          createdAt: existingSourceState?.createdAt ?? nextSource.createdAt,
          updatedAt: nextSource.updatedAt,
        },
      },
    };
    yield* localScope.scopeStateStore.write({
      state: scopeState,
    });

    if (shouldRefreshScopeDeclarationsAfterPersist(nextSource)) {
      yield* syncScopeSourceTypeDeclarationsWithDeps(
        deps,
        nextSource.scopeId,
        options,
      );
    }

    return yield* loadSourceByIdWithDeps(deps, {
      scopeId: nextSource.scopeId,
      sourceId: nextSource.id,
      actorScopeId: options.actorScopeId,
    });
  }).pipe(
    Effect.withSpan("source.store.persist", {
      attributes: {
        "executor.scope.id": source.scopeId,
        "executor.source.id": source.id,
        "executor.source.kind": source.kind,
        "executor.source.status": source.status,
      },
    }),
  );
