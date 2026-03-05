import { type SourceStore, type ToolArtifactStore } from "@executor-v2/persistence-ports";
import {
  type Source,
  type SourceId,
  type ToolArtifact,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  toSourceStoreError,
  toToolArtifactStoreError,
} from "./persistence-errors";
import { tableNames } from "./schema";
import {
  type DrizzleDb,
  type DrizzleTables,
  type SqlBackend,
} from "./sql-internals";

type CreateStoresInput = {
  backend: SqlBackend;
  db: DrizzleDb;
  tables: DrizzleTables;
};

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

const toToolArtifact = (row: {
  id: string;
  workspaceId: string;
  sourceId: string;
  sourceHash: string;
  toolCount: number;
  manifestJson: string;
  createdAt: number;
  updatedAt: number;
}): ToolArtifact => ({
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
  db,
  tables,
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
            .orderBy(sql`lower(${tables.sourcesTable.name})`, asc(tables.sourcesTable.sourceId));

          return rows.map(toSource);
        },
        catch: (cause) =>
          toSourceStoreError(backend, "list_by_workspace", tableNames.sources, cause),
      }),

    upsert: (source: Source) =>
      Effect.tryPromise({
        try: async () => {
          await db
            .insert(tables.sourcesTable)
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
                tables.sourcesTable.workspaceId,
                tables.sourcesTable.sourceId,
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
                updatedAt: source.updatedAt,
              },
            });
        },
        catch: (cause) =>
          toSourceStoreError(backend, "upsert", tableNames.sources, cause),
      }),

    removeById: (workspaceId: WorkspaceId, sourceId: SourceId) =>
      Effect.tryPromise({
        try: async () => {
          const deleted = await db
            .delete(tables.sourcesTable)
            .where(
              and(
                eq(tables.sourcesTable.workspaceId, workspaceId),
                eq(tables.sourcesTable.sourceId, sourceId),
              ),
            )
            .returning();

          return deleted.length > 0;
        },
        catch: (cause) =>
          toSourceStoreError(backend, "remove_by_id", tableNames.sources, cause),
      }),
  };

  const toolArtifactStore: ToolArtifactStore = {
    getBySource: (workspaceId: WorkspaceId, sourceId: SourceId) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({
              id: tables.toolArtifactsTable.id,
              workspaceId: tables.toolArtifactsTable.workspaceId,
              sourceId: tables.toolArtifactsTable.sourceId,
              sourceHash: tables.toolArtifactsTable.sourceHash,
              toolCount: tables.toolManifestsTable.toolCount,
              manifestJson: tables.toolManifestsTable.manifestJson,
              createdAt: tables.toolArtifactsTable.createdAt,
              updatedAt: tables.toolArtifactsTable.updatedAt,
            })
            .from(tables.toolArtifactsTable)
            .innerJoin(
              tables.toolManifestsTable,
              eq(tables.toolArtifactsTable.sourceHash, tables.toolManifestsTable.sourceHash),
            )
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
          const existing = await db
            .select({ sourceHash: tables.toolArtifactsTable.sourceHash })
            .from(tables.toolArtifactsTable)
            .where(
              and(
                eq(tables.toolArtifactsTable.workspaceId, artifact.workspaceId),
                eq(tables.toolArtifactsTable.sourceId, artifact.sourceId),
              ),
            )
            .limit(1);

          const previousSourceHash = existing[0]?.sourceHash;

          await db
            .insert(tables.toolManifestsTable)
            .values({
              sourceHash: artifact.sourceHash,
              toolCount: artifact.toolCount,
              manifestJson: artifact.manifestJson,
              createdAt: artifact.createdAt,
              updatedAt: artifact.updatedAt,
            })
            .onConflictDoUpdate({
              target: tables.toolManifestsTable.sourceHash,
              set: {
                toolCount: sql`excluded.tool_count`,
                manifestJson: sql`excluded.manifest_json`,
                updatedAt: sql`excluded.updated_at`,
              },
            });

          await db
            .insert(tables.toolArtifactsTable)
            .values({
              id: artifact.id,
              workspaceId: artifact.workspaceId,
              sourceId: artifact.sourceId,
              sourceHash: artifact.sourceHash,
              createdAt: artifact.createdAt,
              updatedAt: artifact.updatedAt,
            })
            .onConflictDoUpdate({
              target: [
                tables.toolArtifactsTable.workspaceId,
                tables.toolArtifactsTable.sourceId,
              ],
              set: {
                id: sql`excluded.id`,
                sourceHash: sql`excluded.source_hash`,
                updatedAt: sql`excluded.updated_at`,
              },
            });

          if (previousSourceHash && previousSourceHash !== artifact.sourceHash) {
            await db.execute(sql`
              delete from ${tables.toolManifestsTable}
              where ${tables.toolManifestsTable.sourceHash} = ${previousSourceHash}
                and not exists (
                  select 1
                  from ${tables.toolArtifactsTable}
                  where ${tables.toolArtifactsTable.sourceHash} = ${previousSourceHash}
                )
            `);
          }
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
