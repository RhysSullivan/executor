import type {
  CreateSourcePayload,
  UpdateSourcePayload,
} from "./contracts";
import {
  type AccountId,
  SourceIdSchema,
  type Source,
  type SourceId,
  type WorkspaceId,
} from "../schema";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";

import {
  createSourceFromPayload,
  updateSourceFromPayload,
} from "../runtime/sources/source-definitions";
import { getSourceAdapterForSource } from "../runtime/sources/source-adapters";
import { mapPersistenceError } from "../runtime/policy/operations-shared";
import { operationErrors } from "../runtime/policy/operation-errors";
import {
  ExecutorStateStore,
  type ExecutorStateStoreShape,
} from "../runtime/executor-state-store";
import { RuntimeSourceCatalogSyncService } from "../runtime/catalog/source/sync";
import { RuntimeSourceStoreService } from "../runtime/sources/source-store";

const sourceOps = {
  list: operationErrors("sources.list"),
  create: operationErrors("sources.create"),
  get: operationErrors("sources.get"),
  update: operationErrors("sources.update"),
  remove: operationErrors("sources.remove"),
} as const;

const shouldAutoProbeSource = (source: Source): boolean =>
  getSourceAdapterForSource(source).shouldAutoProbe(source);

const syncArtifactsForSource = (input: {
  store: ExecutorStateStoreShape;
  sourceStore: Effect.Effect.Success<typeof RuntimeSourceStoreService>;
  source: Source;
  actorAccountId: AccountId;
  operation: typeof sourceOps.create | typeof sourceOps.update;
}) =>
  Effect.gen(function* () {
    const catalogSyncService = yield* RuntimeSourceCatalogSyncService;

    // For HTTP-backed source kinds that can validate themselves from a remote
    // document, automatically attempt to probe and connect. This mirrors the
    // addExecutorSource flow by overriding status to "connected" so the sync
    // guard passes.
    const autoProbe = shouldAutoProbeSource(input.source);
    const sourceForSync = autoProbe
      ? { ...input.source, status: "connected" as const }
      : input.source;

    const synced = yield* Effect.either(
      catalogSyncService.sync({
        source: sourceForSync,
        actorAccountId: input.actorAccountId,
      }),
    );

    return yield* Either.match(synced, {
      onRight: () =>
        Effect.gen(function* () {
          if (autoProbe) {
            const connectedSource = yield* updateSourceFromPayload({
              source: input.source,
              payload: { status: "connected", lastError: null },
              now: Date.now(),
            }).pipe(
              Effect.mapError((cause) =>
                input.operation.badRequest(
                  "Failed updating source status",
                  cause instanceof Error ? cause.message : String(cause),
                ),
              ),
            );
            yield* mapPersistenceError(
              input.operation.child("source_connected"),
              input.sourceStore.persistSource(connectedSource, {
                actorAccountId: input.actorAccountId,
              }),
            );
            return connectedSource;
          }
          return input.source;
        }),
      onLeft: (error) =>
        Effect.gen(function* () {
          if (
            autoProbe ||
            (input.source.enabled && input.source.status === "connected")
          ) {
            const erroredSource = yield* updateSourceFromPayload({
              source: input.source,
              payload: {
                status: "error",
                lastError: error.message,
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
                actorAccountId: input.actorAccountId,
              }),
            );
          }

          return yield* input.operation.unknownStorage(
            error,
            "Failed syncing source tools",
          );
        }),
    });
  });

export const listSources = (input: {
  workspaceId: WorkspaceId;
  accountId: AccountId;
}) =>
  Effect.flatMap(ExecutorStateStore, () =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;

      return yield* sourceStore
        .loadSourcesInWorkspace(input.workspaceId, {
          actorAccountId: input.accountId,
        })
        .pipe(
          Effect.mapError((error) =>
            sourceOps.list.unknownStorage(
              error,
              "Failed projecting stored sources",
            ),
          ),
        );
    }),
  );

export const createSource = (input: {
  workspaceId: WorkspaceId;
  accountId: AccountId;
  payload: CreateSourcePayload;
}) =>
  Effect.flatMap(ExecutorStateStore, (store) =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const now = Date.now();

      const source = yield* createSourceFromPayload({
        workspaceId: input.workspaceId,
        sourceId: SourceIdSchema.make(`src_${crypto.randomUUID()}`),
        payload: input.payload,
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
          actorAccountId: input.accountId,
        }),
      );

      const synchronizedSource = yield* syncArtifactsForSource({
        store,
        sourceStore,
        source: persistedSource,
        actorAccountId: input.accountId,
        operation: sourceOps.create,
      });

      return synchronizedSource;
    }),
  );

export const getSource = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  accountId: AccountId;
}) =>
  Effect.flatMap(ExecutorStateStore, () =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;

      return yield* sourceStore
        .loadSourceById({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          actorAccountId: input.accountId,
        })
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof Error &&
            cause.message.startsWith("Source not found:")
              ? sourceOps.get.notFound(
                  "Source not found",
                  `workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
                )
              : sourceOps.get.unknownStorage(
                  cause,
                  "Failed projecting stored source",
                ),
          ),
        );
    }),
  );

export const updateSource = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  accountId: AccountId;
  payload: UpdateSourcePayload;
}) =>
  Effect.flatMap(ExecutorStateStore, (store) =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const existingSource = yield* sourceStore
        .loadSourceById({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          actorAccountId: input.accountId,
        })
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof Error &&
            cause.message.startsWith("Source not found:")
              ? sourceOps.update.notFound(
                  "Source not found",
                  `workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
                )
              : sourceOps.update.unknownStorage(
                  cause,
                  "Failed projecting stored source",
                ),
          ),
        );

      const updatedSource = yield* updateSourceFromPayload({
        source: existingSource,
        payload: input.payload,
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
          actorAccountId: input.accountId,
        }),
      );

      const synchronizedSource = yield* syncArtifactsForSource({
        store,
        sourceStore,
        source: persistedSource,
        actorAccountId: input.accountId,
        operation: sourceOps.update,
      });

      return synchronizedSource;
    }),
  );

export const removeSource = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}) =>
  Effect.flatMap(ExecutorStateStore, () =>
    Effect.gen(function* () {
      const sourceStore = yield* RuntimeSourceStoreService;
      const removed = yield* mapPersistenceError(
        sourceOps.remove.child("remove"),
        sourceStore.removeSourceById({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
        }),
      );

      return { removed };
    }),
  );
