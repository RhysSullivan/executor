import { type SourceStore, type ToolArtifactStore } from "@executor-v2/persistence-ports";
import {
  type Source,
  type SourceId,
  type ToolArtifact,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { and, asc, eq } from "drizzle-orm";

import { SourceJson, ToolArtifactJson } from "./persistence-codecs";
import {
  toSourceStoreError,
  toToolArtifactStoreError,
} from "./persistence-errors";
import { tableNames } from "./schema";
import {
  createDrizzleContext,
  type DrizzleDb,
  type DrizzleTables,
  type SqlAdapter,
  type SqlBackend,
} from "./sql-internals";

type WriteLocked = <A>(run: () => Promise<A>) => Promise<A>;

type CreateStoresInput = {
  backend: SqlBackend;
  adapter: SqlAdapter;
  db: DrizzleDb;
  tables: DrizzleTables;
  writeLocked: WriteLocked;
};

const sourceStoreKey = (source: Source): string => `${source.workspaceId}:${source.id}`;

const sortSources = (sources: ReadonlyArray<Source>): Array<Source> =>
  [...sources].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return sourceStoreKey(left).localeCompare(sourceStoreKey(right));
    }

    return leftName.localeCompare(rightName);
  });

export const createSourceAndArtifactStores = ({
  backend,
  adapter,
  db,
  tables,
  writeLocked,
}: CreateStoresInput): {
  sourceStore: SourceStore;
  toolArtifactStore: ToolArtifactStore;
} => {
  const sourceStore: SourceStore = {
    getById: (workspaceId: WorkspaceId, sourceId: SourceId) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({ payloadJson: tables.sourcesTable.payloadJson })
            .from(tables.sourcesTable)
            .where(
              and(
                eq(tables.sourcesTable.workspaceId, workspaceId),
                eq(tables.sourcesTable.sourceId, sourceId),
              ),
            )
            .limit(1);

          const row = rows[0];
          if (!row) {
            return Option.none<Source>();
          }

          return Option.some(SourceJson.decode(row.payloadJson));
        },
        catch: (cause) =>
          toSourceStoreError(backend, "get_by_id", tableNames.sources, cause),
      }),

    listByWorkspace: (workspaceId: WorkspaceId) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({ payloadJson: tables.sourcesTable.payloadJson })
            .from(tables.sourcesTable)
            .where(eq(tables.sourcesTable.workspaceId, workspaceId))
            .orderBy(asc(tables.sourcesTable.name), asc(tables.sourcesTable.sourceId));

          return sortSources(rows.map((row) => SourceJson.decode(row.payloadJson)));
        },
        catch: (cause) =>
          toSourceStoreError(backend, "list_by_workspace", tableNames.sources, cause),
      }),

    upsert: (source: Source) =>
      Effect.tryPromise({
        try: async () => {
          await writeLocked(async () => {
            await adapter.transaction(async (transaction) => {
              const transactionContext = createDrizzleContext(transaction);
              const payloadJson = SourceJson.encode(source);
              const updatedAt = Date.now();

              await transactionContext.db
                .insert(transactionContext.tables.sourcesTable)
                .values({
                  workspaceId: source.workspaceId,
                  sourceId: source.id,
                  name: source.name,
                  payloadJson,
                  updatedAt,
                })
                .onConflictDoUpdate({
                  target: [
                    transactionContext.tables.sourcesTable.workspaceId,
                    transactionContext.tables.sourcesTable.sourceId,
                  ],
                  set: {
                    name: source.name,
                    payloadJson,
                    updatedAt,
                  },
                });
            });
          });
        },
        catch: (cause) =>
          toSourceStoreError(backend, "upsert", tableNames.sources, cause),
      }),

    removeById: (workspaceId: WorkspaceId, sourceId: SourceId) =>
      Effect.tryPromise({
        try: async () =>
          writeLocked(async () =>
            adapter.transaction(async (transaction) => {
              const transactionContext = createDrizzleContext(transaction);
              const existing = await transactionContext.db
                .select({ sourceId: transactionContext.tables.sourcesTable.sourceId })
                .from(transactionContext.tables.sourcesTable)
                .where(
                  and(
                    eq(transactionContext.tables.sourcesTable.workspaceId, workspaceId),
                    eq(transactionContext.tables.sourcesTable.sourceId, sourceId),
                  ),
                )
                .limit(1);

              if (existing.length === 0) {
                return false;
              }

              await transactionContext.db
                .delete(transactionContext.tables.sourcesTable)
                .where(
                  and(
                    eq(transactionContext.tables.sourcesTable.workspaceId, workspaceId),
                    eq(transactionContext.tables.sourcesTable.sourceId, sourceId),
                  ),
                );

              return true;
            })
          ),
        catch: (cause) =>
          toSourceStoreError(backend, "remove_by_id", tableNames.sources, cause),
      }),
  };

  const toolArtifactStore: ToolArtifactStore = {
    getBySource: (workspaceId: WorkspaceId, sourceId: SourceId) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({ payloadJson: tables.toolArtifactsTable.payloadJson })
            .from(tables.toolArtifactsTable)
            .where(
              and(
                eq(tables.toolArtifactsTable.workspaceId, workspaceId),
                eq(tables.toolArtifactsTable.sourceId, sourceId),
              ),
            )
            .limit(1);

          const row = rows[0];
          if (!row) {
            return Option.none<ToolArtifact>();
          }

          return Option.some(ToolArtifactJson.decode(row.payloadJson));
        },
        catch: (cause) =>
          toToolArtifactStoreError(
            backend,
            "get_by_source",
            tableNames.toolArtifacts,
            cause,
          ),
      }),

    upsert: (artifact: ToolArtifact) =>
      Effect.tryPromise({
        try: async () => {
          await writeLocked(async () => {
            await adapter.transaction(async (transaction) => {
              const transactionContext = createDrizzleContext(transaction);
              const payloadJson = ToolArtifactJson.encode(artifact);
              const updatedAt = Date.now();

              await transactionContext.db
                .insert(transactionContext.tables.toolArtifactsTable)
                .values({
                  workspaceId: artifact.workspaceId,
                  sourceId: artifact.sourceId,
                  payloadJson,
                  updatedAt,
                })
                .onConflictDoUpdate({
                  target: [
                    transactionContext.tables.toolArtifactsTable.workspaceId,
                    transactionContext.tables.toolArtifactsTable.sourceId,
                  ],
                  set: {
                    payloadJson,
                    updatedAt,
                  },
                });
            });
          });
        },
        catch: (cause) =>
          toToolArtifactStoreError(backend, "upsert", tableNames.toolArtifacts, cause),
      }),
  };

  return {
    sourceStore,
    toolArtifactStore,
  };
};
