// ---------------------------------------------------------------------------
// @executor/storage-postgres — BlobStore backed by a `blob` table in the
// same postgres database as the adapter. Keeps plugin-owned opaque blobs
// (onepassword config, workos-vault metadata, etc.) persistent across
// restarts / Worker invocations without needing a second storage seam.
//
// DDL is NOT run here — the `blob` table is expected to exist before this
// runs. Consumers materialize schema via drizzle-kit (or equivalent)
// out-of-band.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import type { BlobStore } from "@executor/sdk";
import { StorageError } from "@executor/storage-core";

export const blobTable = pgTable(
  "blob",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.namespace, t.key] }) }),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzlePgDB = PgDatabase<any, any, any>;

export interface MakePostgresBlobStoreOptions {
  readonly db: DrizzlePgDB;
}

const wrapErr =
  (op: string) =>
  (cause: unknown): StorageError => {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return new StorageError({
      message: `[storage-postgres] blob ${op}: ${msg}`,
      cause,
    });
  };

export const makePostgresBlobStore = (
  options: MakePostgresBlobStoreOptions,
): BlobStore => ({
  get: (namespace, key) =>
    Effect.tryPromise({
      try: async () => {
        const rows = await options.db
          .select({ value: blobTable.value })
          .from(blobTable)
          .where(
            and(
              eq(blobTable.namespace, namespace),
              eq(blobTable.key, key),
            ),
          )
          .limit(1);
        return rows[0]?.value ?? null;
      },
      catch: wrapErr("get"),
    }),
  getMany: (namespaces, key) =>
    namespaces.length === 0
      ? Effect.succeed(new Map<string, string>())
      : Effect.tryPromise({
          try: async () => {
            const rows = await options.db
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
              );
            const out = new Map<string, string>();
            for (const row of rows) out.set(row.namespace, row.value);
            return out as ReadonlyMap<string, string>;
          },
          catch: wrapErr("getMany"),
        }),
  put: (namespace, key, value) =>
    Effect.tryPromise({
      try: async () => {
        await options.db
          .insert(blobTable)
          .values({ namespace, key, value })
          .onConflictDoUpdate({
            target: [blobTable.namespace, blobTable.key],
            set: { value },
          });
      },
      catch: wrapErr("put"),
    }),
  delete: (namespace, key) =>
    Effect.tryPromise({
      try: async () => {
        await options.db
          .delete(blobTable)
          .where(
            and(
              eq(blobTable.namespace, namespace),
              eq(blobTable.key, key),
            ),
          );
      },
      catch: wrapErr("delete"),
    }),
  has: (namespace, key) =>
    Effect.tryPromise({
      try: async () => {
        const rows = await options.db
          .select({ key: blobTable.key })
          .from(blobTable)
          .where(
            and(
              eq(blobTable.namespace, namespace),
              eq(blobTable.key, key),
            ),
          )
          .limit(1);
        return rows.length > 0;
      },
      catch: wrapErr("has"),
    }),
});
