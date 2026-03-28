import {
  type ScopeId,
  SourceIdSchema,
  type Source,
  type SourceId,
} from "../schema";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";

import {
  normalizeSourceForCreate,
  normalizeSourceForSave,
} from "../runtime/sources/source-definitions";
import {
  mapPersistenceError,
} from "../runtime/policy/operations-shared";
import {
  operationErrors,
} from "../runtime/policy/operation-errors";
import {
  ExecutorStateStore,
  type ExecutorStateStoreShape,
} from "../runtime/executor-state-store";
import {
  RuntimeSourceCatalogSyncService,
} from "../runtime/catalog/source/sync";
import {
  RuntimeSourceStoreService,
} from "../runtime/sources/source-store";

const sourceOps = {
  list: operationErrors("sources.list"),
  create: operationErrors("sources.create"),
  get: operationErrors("sources.get"),
  update: operationErrors("sources.update"),
  remove: operationErrors("sources.remove"),
} as const;

const syncArtifactsForSource = (input: {
  store: ExecutorStateStoreShape;
  sourceStore: Effect.Effect.Success<typeof RuntimeSourceStoreService>;
  source: Source;
  actorScopeId: ScopeId;
  operation: typeof sourceOps.create | typeof sourceOps.update;
}) =>
  Effect.gen(function* () {
    const catalogSyncService = yield* RuntimeSourceCatalogSyncService;

    const synced = yield* Effect.either(
      catalogSyncService.sync({
        source: input.source,
        actorScopeId: input.actorScopeId,
      }),
    );

    return yield* Either.match(synced, {
      onRight: () => Effect.succeed(input.source),
      onLeft: (error) =>
        Effect.gen(function* () {
          if (input.source.enabled && input.source.status === "connected") {
            const erroredSource = yield* normalizeSourceForSave({
              source: {
                ...input.source,
                status: "error",
              },
              now: Date.now(),
            }).pipe(
              Effect.mapError((cause) =>
                input.operation.badRequest(
                  "Failed indexing source tools",
                  cause instanceof Error ? cause.message : String(cause),
                ),
              ),
            );

            yield* mapPersistenceError(
              input.operation.child("source_error"),
              input.sourceStore.persistSource(erroredSource, {
                actorScopeId: input.actorScopeId,
              }),
            );

            return erroredSource;
          }

          return yield* input.operation.unknownStorage(
            error,
            "Failed syncing source tools",
          );
        }),
    });
  });

export const listSources = (input: {
  scopeId: ScopeId;
  actorScopeId: ScopeId;
}) =>
  Effect.flatMap(ExecutorStateStore, () =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;

      return yield* sourceStore.loadSourcesInScope(input.scopeId, {
        actorScopeId: input.actorScopeId,
      }).pipe(
        Effect.mapError((error) =>
          sourceOps.list.unknownStorage(
            error,
            "Failed projecting stored sources",
          ),
        ),
      );
    }),
  );

export const createManagedSource = (input: {
  scopeId: ScopeId;
  actorScopeId: ScopeId;
  source: Omit<
    Source,
    "id" | "scopeId" | "createdAt" | "updatedAt"
  >;
}) =>
  Effect.flatMap(ExecutorStateStore, (store) =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const now = Date.now();

      const source = yield* normalizeSourceForCreate({
        scopeId: input.scopeId,
        sourceId: SourceIdSchema.make(`src_${crypto.randomUUID()}`),
        source: input.source,
        now,
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.create.badRequest(
            "Invalid source definition",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      );

      const persistedSource = yield* mapPersistenceError(
        sourceOps.create.child("persist"),
        sourceStore.persistSource(source, {
          actorScopeId: input.actorScopeId,
        }),
      );

      const synchronizedSource = yield* syncArtifactsForSource({
        store,
        sourceStore,
        source: persistedSource,
        actorScopeId: input.actorScopeId,
        operation: sourceOps.create,
      });

      return synchronizedSource;
    }),
  );

export const createManagedSourceRecord = (input: {
  scopeId: ScopeId;
  actorScopeId: ScopeId;
  source: Omit<
    Source,
    "id" | "scopeId" | "createdAt" | "updatedAt"
  >;
}) =>
  Effect.flatMap(ExecutorStateStore, () =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const now = Date.now();

      const source = yield* normalizeSourceForCreate({
        scopeId: input.scopeId,
        sourceId: SourceIdSchema.make(`src_${crypto.randomUUID()}`),
        source: input.source,
        now,
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.create.badRequest(
            "Invalid source definition",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      );

      return yield* mapPersistenceError(
        sourceOps.create.child("persist"),
        sourceStore.persistSource(source, {
          actorScopeId: input.actorScopeId,
        }),
      );
    }),
  );

export const getSource = (input: {
  scopeId: ScopeId;
  sourceId: SourceId;
  actorScopeId: ScopeId;
}) =>
  Effect.flatMap(ExecutorStateStore, () =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;

      return yield* sourceStore.loadSourceById({
        scopeId: input.scopeId,
        sourceId: input.sourceId,
        actorScopeId: input.actorScopeId,
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error &&
          cause.message.startsWith("Source not found:")
            ? sourceOps.get.notFound(
                "Source not found",
                `scopeId=${input.scopeId} sourceId=${input.sourceId}`,
              )
            : sourceOps.get.unknownStorage(
                cause,
                "Failed projecting stored source",
              ),
        ),
      );
    }),
  );

export const saveManagedSource = (input: {
  actorScopeId: ScopeId;
  source: Source;
}) =>
  Effect.flatMap(ExecutorStateStore, (store) =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const updatedSource = yield* normalizeSourceForSave({
        source: input.source,
        now: Date.now(),
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.update.badRequest(
            "Invalid source definition",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      );

      const persistedSource = yield* mapPersistenceError(
        sourceOps.update.child("persist"),
        sourceStore.persistSource(updatedSource, {
          actorScopeId: input.actorScopeId,
        }),
      );

      const synchronizedSource = yield* syncArtifactsForSource({
        store,
        sourceStore,
        source: persistedSource,
        actorScopeId: input.actorScopeId,
        operation: sourceOps.update,
      });

      return synchronizedSource;
    }),
  );

export const saveManagedSourceRecord = (input: {
  actorScopeId: ScopeId;
  source: Source;
}) =>
  Effect.flatMap(ExecutorStateStore, () =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const updatedSource = yield* normalizeSourceForSave({
        source: input.source,
        now: Date.now(),
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.update.badRequest(
            "Invalid source definition",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      );

      return yield* mapPersistenceError(
        sourceOps.update.child("persist"),
        sourceStore.persistSource(updatedSource, {
          actorScopeId: input.actorScopeId,
        }),
      );
    }),
  );

export const refreshManagedSourceCatalog = (input: {
  scopeId: ScopeId;
  sourceId: SourceId;
  actorScopeId: ScopeId;
}) =>
  Effect.flatMap(ExecutorStateStore, (store) =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const source = yield* sourceStore.loadSourceById({
        scopeId: input.scopeId,
        sourceId: input.sourceId,
        actorScopeId: input.actorScopeId,
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error &&
          cause.message.startsWith("Source not found:")
            ? sourceOps.get.notFound(
                "Source not found",
                `scopeId=${input.scopeId} sourceId=${input.sourceId}`,
              )
            : sourceOps.get.unknownStorage(
                cause,
                "Failed projecting stored source",
              ),
        ),
      );

      yield* syncArtifactsForSource({
        store,
        sourceStore,
        source,
        actorScopeId: input.actorScopeId,
        operation: sourceOps.update,
      });

      return yield* sourceStore.loadSourceById({
        scopeId: input.scopeId,
        sourceId: input.sourceId,
        actorScopeId: input.actorScopeId,
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.update.unknownStorage(
            cause,
            "Failed loading refreshed source",
          ),
        ),
      );
    }),
  );

export const removeSource = (input: {
  scopeId: ScopeId;
  sourceId: SourceId;
}) =>
  Effect.flatMap(ExecutorStateStore, () =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const removed = yield* mapPersistenceError(
        sourceOps.remove.child("remove"),
        sourceStore.removeSourceById({
          scopeId: input.scopeId,
          sourceId: input.sourceId,
        }),
      );

      return { removed };
    }),
  );
