import {
  type StoredSourceRecord,
  StoredSourceRecordSchema,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, asc, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodeStoredSourceRecord = Schema.decodeUnknownSync(StoredSourceRecordSchema);
const encodeStoredSourceRecord = Schema.encodeSync(StoredSourceRecordSchema);

const toSourceUpdateSet = (
  patch: Partial<Omit<StoredSourceRecord, "id" | "workspaceId" | "createdAt">>,
): Partial<DrizzleTables["sourcesTable"]["$inferInsert"]> => {
  const set: Partial<DrizzleTables["sourcesTable"]["$inferInsert"]> = {};

  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.endpoint !== undefined) set.endpoint = patch.endpoint;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.namespace !== undefined) set.namespace = patch.namespace;
  if (patch.transport !== undefined) set.transport = patch.transport;
  if (patch.queryParamsJson !== undefined) set.queryParamsJson = patch.queryParamsJson;
  if (patch.headersJson !== undefined) set.headersJson = patch.headersJson;
  if (patch.specUrl !== undefined) set.specUrl = patch.specUrl;
  if (patch.defaultHeadersJson !== undefined) {
    set.defaultHeadersJson = patch.defaultHeadersJson;
  }
  if (patch.authKind !== undefined) set.authKind = patch.authKind;
  if (patch.authHeaderName !== undefined) set.authHeaderName = patch.authHeaderName;
  if (patch.authPrefix !== undefined) set.authPrefix = patch.authPrefix;
  if (patch.sourceHash !== undefined) set.sourceHash = patch.sourceHash;
  if (patch.lastError !== undefined) set.lastError = patch.lastError;
  if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;

  return set;
};

export const createSourcesRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listByWorkspaceId: (workspaceId: StoredSourceRecord["workspaceId"]) =>
    client.use("rows.sources.list_by_workspace", async (db) => {
      const rows = await db
        .select()
        .from(tables.sourcesTable)
        .where(eq(tables.sourcesTable.workspaceId, workspaceId))
        .orderBy(asc(tables.sourcesTable.updatedAt), asc(tables.sourcesTable.sourceId));

      return rows.map((row) => decodeStoredSourceRecord(row));
    }),

  getByWorkspaceAndId: (
    workspaceId: StoredSourceRecord["workspaceId"],
    sourceId: StoredSourceRecord["id"],
  ) =>
    client.use("rows.sources.get_by_workspace_and_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.sourcesTable)
        .where(
          and(
            eq(tables.sourcesTable.workspaceId, workspaceId),
            eq(tables.sourcesTable.sourceId, sourceId),
          ),
        )
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeStoredSourceRecord(row.value))
        : Option.none<StoredSourceRecord>();
    }),

  insert: (source: StoredSourceRecord) =>
    client.use("rows.sources.insert", async (db) => {
      await db.insert(tables.sourcesTable).values(encodeStoredSourceRecord(source));
    }),

  update: (
    workspaceId: StoredSourceRecord["workspaceId"],
    sourceId: StoredSourceRecord["id"],
    patch: Partial<Omit<StoredSourceRecord, "id" | "workspaceId" | "createdAt">>,
  ) =>
    client.use("rows.sources.update", async (db) => {
      const rows = await db
        .update(tables.sourcesTable)
        .set(toSourceUpdateSet(patch))
        .where(
          and(
            eq(tables.sourcesTable.workspaceId, workspaceId),
            eq(tables.sourcesTable.sourceId, sourceId),
          ),
        )
        .returning();

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeStoredSourceRecord(row.value))
        : Option.none<StoredSourceRecord>();
    }),

  removeByWorkspaceAndId: (
    workspaceId: StoredSourceRecord["workspaceId"],
    sourceId: StoredSourceRecord["id"],
  ) =>
    client.useTx("rows.sources.remove", async (tx) => {
      await tx
        .delete(tables.sourceCredentialBindingsTable)
        .where(
          and(
            eq(tables.sourceCredentialBindingsTable.workspaceId, workspaceId),
            eq(tables.sourceCredentialBindingsTable.sourceId, sourceId),
          ),
        );

      const deleted = await tx
        .delete(tables.sourcesTable)
        .where(
          and(
            eq(tables.sourcesTable.workspaceId, workspaceId),
            eq(tables.sourcesTable.sourceId, sourceId),
          ),
        )
        .returning();

      return deleted.length > 0;
    }),
});
