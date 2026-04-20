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
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { BlobStore } from "@executor/sdk";
import { StorageError } from "@executor/storage-core";

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
  (cause: unknown): StorageError => {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return new StorageError({
      message: `[storage-file] blob ${op}: ${msg}`,
      cause,
    });
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

  getMany: (namespaces, key) =>
    namespaces.length === 0
      ? Effect.succeed(new Map<string, string>())
      : Effect.try({
          try: () =>
            options.db
              .select({
                namespace: blobTable.namespace,
                value: blobTable.value,
              })
              .from(blobTable)
              .where(
                and(
                  inArray(blobTable.namespace, [...namespaces]),
                  eq(blobTable.key, key),
                ),
              )
              .all() as ReadonlyArray<{ namespace: string; value: string }>,
          catch: wrapErr("getMany"),
        }).pipe(
          Effect.map((rows) => {
            const out = new Map<string, string>();
            for (const row of rows) out.set(row.namespace, row.value);
            return out;
          }),
        ),

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
