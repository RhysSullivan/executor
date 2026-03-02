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

const toSource = (row: DrizzleTables["sourcesTable"]["$inferSelect"]): Source => ({
  id: row.sourceId as Source["id"],
  workspaceId: row.workspaceId as Source["workspaceId"],
  name: row.name,
  kind: row.kind as Source["kind"],
  endpoint: row.endpoint,
  status: row.status as Source["status"],
  enabled: row.enabled,
  configJson: row.configJson,
  sourceHash: row.sourceHash,
  lastError: row.lastError,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toToolArtifact = (
  row: DrizzleTables["toolArtifactsTable"]["$inferSelect"],
): ToolArtifact => ({
  id: row.id as ToolArtifact["id"],
  workspaceId: row.workspaceId as ToolArtifact["workspaceId"],
  sourceId: row.sourceId as ToolArtifact["sourceId"],
  sourceHash: row.sourceHash,
  toolCount: row.toolCount,
  manifestJson: row.manifestJson,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
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
          const rows = await db.select().from(tables.sourcesTable).where(
            and(
              eq(tables.sourcesTable.workspaceId, workspaceId),
              eq(tables.sourcesTable.sourceId, sourceId),
            ),
          ).limit(1);

          const row = rows[0];
          if (!row) {
            return Option.none<Source>();
          }

          return Option.some(toSource(row));
        },
        catch: (cause) =>
          toSourceStoreError(backend, "get_by_id", tableNames.sources, cause),
      }),

    listByWorkspace: (workspaceId: WorkspaceId) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select()
            .from(tables.sourcesTable)
            .where(eq(tables.sourcesTable.workspaceId, workspaceId))
            .orderBy(asc(tables.sourcesTable.name), asc(tables.sourcesTable.sourceId));

          return sortSources(rows.map(toSource));
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

              await transactionContext.db
                .insert(transactionContext.tables.sourcesTable)
                .values({
                  workspaceId: source.workspaceId,
                  sourceId: source.id,
                  name: source.name,
                  kind: source.kind,
                  endpoint: source.endpoint,
                  status: source.status,
                  enabled: source.enabled,
                  configJson: source.configJson,
                  sourceHash: source.sourceHash,
                  lastError: source.lastError,
                  createdAt: source.createdAt,
                  updatedAt: source.updatedAt,
                })
                .onConflictDoUpdate({
                  target: [
                    transactionContext.tables.sourcesTable.workspaceId,
                    transactionContext.tables.sourcesTable.sourceId,
                  ],
                  set: {
                    name: source.name,
                    kind: source.kind,
                    endpoint: source.endpoint,
                    status: source.status,
                    enabled: source.enabled,
                    configJson: source.configJson,
                    sourceHash: source.sourceHash,
                    lastError: source.lastError,
                    createdAt: source.createdAt,
                    updatedAt: source.updatedAt,
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
            .select()
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

          return Option.some(toToolArtifact(row));
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

              await transactionContext.db
                .insert(transactionContext.tables.toolArtifactsTable)
                .values({
                  id: artifact.id,
                  workspaceId: artifact.workspaceId,
                  sourceId: artifact.sourceId,
                  sourceHash: artifact.sourceHash,
                  toolCount: artifact.toolCount,
                  manifestJson: artifact.manifestJson,
                  createdAt: artifact.createdAt,
                  updatedAt: artifact.updatedAt,
                })
                .onConflictDoUpdate({
                  target: [
                    transactionContext.tables.toolArtifactsTable.workspaceId,
                    transactionContext.tables.toolArtifactsTable.sourceId,
                  ],
                  set: {
                    id: artifact.id,
                    sourceHash: artifact.sourceHash,
                    toolCount: artifact.toolCount,
                    manifestJson: artifact.manifestJson,
                    createdAt: artifact.createdAt,
                    updatedAt: artifact.updatedAt,
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
