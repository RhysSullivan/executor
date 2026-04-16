// ---------------------------------------------------------------------------
// @executor/storage-file
//
// SQLite-backed DBAdapter + BlobStore for the executor runtime. Thin
// wrapper around @executor/storage-drizzle — delegates all queries to
// the shared drizzle adapter.
//
// Callers construct the drizzle db with the generated schema and run
// migrations before creating the adapter:
//
//   import { Database } from "bun:sqlite"
//   import { drizzle } from "drizzle-orm/bun-sqlite"
//   import { migrate } from "drizzle-orm/bun-sqlite/migrator"
//   import * as schema from "./executor-schema"
//   import { makeSqliteAdapter } from "@executor/storage-file"
//
//   const db = drizzle(new Database("data.db"), { schema })
//   migrate(db, { migrationsFolder: "./drizzle" })
//   const adapter = makeSqliteAdapter({ db, schema: pluginSchema })
// ---------------------------------------------------------------------------

export { makeSqliteAdapter, type MakeSqliteAdapterOptions } from "./adapter";
export { makeSqliteBlobStore, blobTable } from "./blob-store";
