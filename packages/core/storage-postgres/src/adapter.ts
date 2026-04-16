// ---------------------------------------------------------------------------
// @executor/storage-postgres — DBAdapter backed by drizzle-orm/postgres-js.
//
// Thin wrapper: delegates all query work to @executor/storage-drizzle.
// The drizzle db must be constructed with the generated schema so that
// db._.fullSchema is populated.
//
// Migrations are out of scope — consumers run drizzle-kit against the
// generated schema file.
// ---------------------------------------------------------------------------

import type { DBAdapter, DBSchema } from "@executor/storage-core";
import { drizzleAdapter } from "@executor/storage-drizzle";

export interface MakePostgresAdapterOptions {
  /**
   * A drizzle postgres database constructed with `{ schema }` so that
   * `db._.fullSchema` and `db.query[model]` are populated. Migrations
   * must be applied out-of-band via drizzle-kit.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
  readonly schema: DBSchema;
  readonly adapterId?: string;
  readonly generateId?: () => string;
}

export const makePostgresAdapter = (
  options: MakePostgresAdapterOptions,
): DBAdapter =>
  drizzleAdapter({
    db: options.db,
    schema: options.schema,
    provider: "pg",
    adapterId: options.adapterId ?? "postgres",
    supportsTransaction: true,
    customIdGenerator: options.generateId
      ? () => options.generateId!()
      : undefined,
  });
