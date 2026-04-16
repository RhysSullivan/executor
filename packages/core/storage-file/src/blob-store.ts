// ---------------------------------------------------------------------------
// @executor/storage-file — BlobStore backed by a `blob` table in the same
// drizzle sqlite database the adapter uses. Keeps plugin-owned opaque
// blobs (onepassword config, workos-vault metadata, etc.) persistent
// across restarts without needing a second storage seam.
//
// DDL is NOT run here — the `blob` table is expected to exist before this
// runs. Consumers materialize schema via drizzle-kit migrations.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { BlobStore } from "@executor/sdk";

export const blobTable = sqliteTable(
  "blob",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.namespace, t.key] }) }),
);

// Structural type covering drizzle-orm/bun-sqlite and drizzle-orm/better-sqlite3.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleSqliteDB = any;

export interface MakeSqliteBlobStoreOptions {
  readonly db: DrizzleSqliteDB;
}

const wrapErr =
  (op: string) =>
  (e: unknown): Error => {
    const msg = e instanceof Error ? e.message : String(e);
    return new Error(`[storage-file] blob ${op}: ${msg}`);
  };

export const makeSqliteBlobStore = (
  options: MakeSqliteBlobStoreOptions,
): BlobStore => ({
  get: (namespace, key) =>
    Effect.try({
      try: () =>
        options.db
          .select({ value: blobTable.value })
          .from(blobTable)
          .where(
            and(
              eq(blobTable.namespace, namespace),
              eq(blobTable.key, key),
            ),
          )
          .limit(1)
          .all() as ReadonlyArray<{ value: string }>,
      catch: wrapErr("get"),
    }).pipe(Effect.map((rows) => rows[0]?.value ?? null)),

  put: (namespace, key, value) =>
    Effect.try({
      try: () =>
        options.db
          .insert(blobTable)
          .values({ namespace, key, value })
          .onConflictDoUpdate({
            target: [blobTable.namespace, blobTable.key],
            set: { value },
          })
          .run(),
      catch: wrapErr("put"),
    }).pipe(Effect.asVoid),

  delete: (namespace, key) =>
    Effect.try({
      try: () =>
        options.db
          .delete(blobTable)
          .where(
            and(
              eq(blobTable.namespace, namespace),
              eq(blobTable.key, key),
            ),
          )
          .run(),
      catch: wrapErr("delete"),
    }).pipe(Effect.asVoid),

  has: (namespace, key) =>
    Effect.try({
      try: () =>
        options.db
          .select({ one: drizzleSql<number>`1`.as("one") })
          .from(blobTable)
          .where(
            and(
              eq(blobTable.namespace, namespace),
              eq(blobTable.key, key),
            ),
          )
          .limit(1)
          .all() as ReadonlyArray<{ one: number }>,
      catch: wrapErr("has"),
    }).pipe(Effect.map((rows) => rows.length > 0)),
});
