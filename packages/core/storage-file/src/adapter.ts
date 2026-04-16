// ---------------------------------------------------------------------------
// makeSqliteAdapter — thin wrapper around @executor/storage-drizzle.
//
// Takes a drizzle sqlite db (constructed with { schema }) plus a DBSchema
// and delegates all query work to the drizzle-backed DBAdapter. The db
// must have been created with the generated schema so that
// db._.fullSchema is populated.
//
// DDL / migrations are NOT run here. Callers are expected to run
// drizzle-kit migrations before constructing the adapter.
// ---------------------------------------------------------------------------

import type { DBAdapter, DBSchema } from "@executor/storage-core";
import { drizzleAdapter } from "@executor/storage-drizzle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleSqliteDB = any;

export interface MakeSqliteAdapterOptions {
  /**
   * A drizzle sqlite database constructed with `{ schema }` so that
   * `db._.fullSchema` and `db.query[model]` are populated. Migrations
   * must be applied before constructing the adapter.
   */
  readonly db: DrizzleSqliteDB;
  readonly schema: DBSchema;
  readonly adapterId?: string;
  readonly generateId?: () => string;
}

export const makeSqliteAdapter = (
  options: MakeSqliteAdapterOptions,
): DBAdapter =>
  drizzleAdapter({
    db: options.db,
    schema: options.schema,
    provider: "sqlite",
    adapterId: options.adapterId ?? "sqlite",
    supportsTransaction: true,
    customIdGenerator: options.generateId
      ? () => options.generateId!()
      : undefined,
  });
