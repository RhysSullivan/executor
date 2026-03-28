import type {
  ScopeId,
  Source,
  SourceId,
} from "#schema";
import { SourceIdSchema } from "#schema";
import * as Effect from "effect/Effect";

import type { LoadedLocalExecutorConfig } from "../../scope-config";
import {
  LocalConfiguredSourceNotFoundError,
  RuntimeLocalScopeMismatchError,
  RuntimeLocalScopeUnavailableError,
} from "../../scope-errors";
import type { LocalScopeState } from "../../scope-state";
import {
  resolveRuntimeLocalScopeFromDeps,
  type RuntimeSourceStoreDeps,
} from "./deps";
import { trimOrNull } from "./config";

export const buildLocalSourceRecord = (input: {
  scopeId: ScopeId;
  loadedConfig: LoadedLocalExecutorConfig;
  scopeState: LocalScopeState;
  sourceId: SourceId;
}): Effect.Effect<
  {
    source: Source;
    sourceId: SourceId;
  },
  LocalConfiguredSourceNotFoundError | Error,
  never
> =>
  Effect.gen(function* () {
    const sourceConfig = input.loadedConfig.config?.sources?.[input.sourceId];
    if (!sourceConfig) {
      return yield* new LocalConfiguredSourceNotFoundError({
        message: `Configured source not found for id ${input.sourceId}`,
        sourceId: input.sourceId,
      });
    }

    const existingState = input.scopeState.sources[input.sourceId];
    const source: Source = {
      id: SourceIdSchema.make(input.sourceId),
      scopeId: input.scopeId,
      name: trimOrNull(sourceConfig.name) ?? input.sourceId,
      kind: sourceConfig.kind,
      status:
        existingState?.status ??
        (sourceConfig.enabled ?? true ? "connected" : "draft"),
      enabled: sourceConfig.enabled ?? true,
      namespace: trimOrNull(sourceConfig.namespace) ?? input.sourceId,
      createdAt: existingState?.createdAt ?? Date.now(),
      updatedAt: existingState?.updatedAt ?? Date.now(),
    };

    return {
      source,
      sourceId: input.sourceId,
    };
  });

export const loadSourcesInWorkspaceWithDeps = (
  deps: RuntimeSourceStoreDeps,
  scopeId: ScopeId,
  _options: {
    actorScopeId?: ScopeId | null;
  } = {},
): Effect.Effect<
  readonly Source[],
  | RuntimeLocalScopeUnavailableError
  | RuntimeLocalScopeMismatchError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const localScope = yield* resolveRuntimeLocalScopeFromDeps(
      deps,
      scopeId,
    );
    const sources = yield* Effect.forEach(
      Object.keys(localScope.loadedConfig.config?.sources ?? {}),
      (sourceId) =>
        Effect.map(
          buildLocalSourceRecord({
            scopeId,
            loadedConfig: localScope.loadedConfig,
            scopeState: localScope.scopeState,
            sourceId: SourceIdSchema.make(sourceId),
          }),
          ({ source }) => source,
        ),
    );
    yield* Effect.annotateCurrentSpan("executor.source.count", sources.length);
    return sources;
  }).pipe(
    Effect.withSpan("source.store.load_scope", {
      attributes: {
        "executor.scope.id": scopeId,
      },
    }),
  );

export const syncScopeSourceTypeDeclarationsWithDeps = (
  deps: RuntimeSourceStoreDeps,
  scopeId: ScopeId,
  options: {
    actorScopeId?: ScopeId | null;
  } = {},
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    yield* resolveRuntimeLocalScopeFromDeps(
      deps,
      scopeId,
    );
    const sources = yield* loadSourcesInWorkspaceWithDeps(
      deps,
      scopeId,
      options,
    );
    const entries = yield* Effect.forEach(sources, (source) =>
      Effect.map(
        deps.sourceArtifactStore.read({
          sourceId: source.id,
        }),
        (artifact) =>
          artifact === null
            ? null
            : {
                source,
                snapshot: artifact.snapshot,
              },
      ),
    );

    yield* deps.sourceTypeDeclarationsRefresher.refreshWorkspaceInBackground({
      entries: entries.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      ),
    });
  }).pipe(
    Effect.withSpan("source.types.refresh_scope.schedule", {
      attributes: {
        "executor.scope.id": scopeId,
      },
    }),
  );

export const shouldRefreshScopeDeclarationsAfterPersist = (source: Source): boolean =>
  source.enabled === false ||
  source.status === "auth_required" ||
  source.status === "error" ||
  source.status === "draft";

export const listLinkedSecretSourcesInWorkspaceWithDeps = (
  deps: RuntimeSourceStoreDeps,
  scopeId: ScopeId,
  options: {
    actorScopeId?: ScopeId | null;
  } = {},
): Effect.Effect<
  Map<string, Array<{ sourceId: string; sourceName: string }>>,
  | RuntimeLocalScopeUnavailableError
  | RuntimeLocalScopeMismatchError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    yield* loadSourcesInWorkspaceWithDeps(deps, scopeId, {
      actorScopeId: options.actorScopeId,
    });
    return new Map<string, Array<{ sourceId: string; sourceName: string }>>();
  });

export const loadSourceByIdWithDeps = (
  deps: RuntimeSourceStoreDeps,
  input: {
    scopeId: ScopeId;
    sourceId: Source["id"];
    actorScopeId?: ScopeId | null;
  },
): Effect.Effect<
  Source,
  | RuntimeLocalScopeUnavailableError
  | RuntimeLocalScopeMismatchError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const localScope = yield* resolveRuntimeLocalScopeFromDeps(
      deps,
      input.scopeId,
    );
    if (!localScope.loadedConfig.config?.sources?.[input.sourceId]) {
      return yield* new LocalConfiguredSourceNotFoundError({
        message: `Source not found: scopeId=${input.scopeId} sourceId=${input.sourceId}`,
        sourceId: input.sourceId,
      });
    }

    const localSource = yield* buildLocalSourceRecord({
      scopeId: input.scopeId,
      loadedConfig: localScope.loadedConfig,
      scopeState: localScope.scopeState,
      sourceId: input.sourceId,
    });

    return localSource.source;
  }).pipe(
    Effect.withSpan("source.store.load_by_id", {
      attributes: {
        "executor.scope.id": input.scopeId,
        "executor.source.id": input.sourceId,
      },
    }),
  );
