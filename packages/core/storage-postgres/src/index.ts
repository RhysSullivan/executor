// ---------------------------------------------------------------------------
// @executor/storage-postgres — Postgres `ExecutorStorage` adapter
//
// Thin package: it just exposes the Postgres implementation of the
// generic storage contract in `@executor/storage`.
//
// Usage:
//
//   import { makePostgresStorage, migratePostgresStorage } from "@executor/storage-postgres"
//   import { drizzle } from "drizzle-orm/node-postgres"
//   import { composeExecutorSchema } from "@executor/storage"
//
//   const db = drizzle(pool)
//   const schema = composeExecutorSchema({ plugins })
//   const storage = yield* makePostgresStorage(db, { schema })
//   const executor = yield* createExecutor({ scope, storage, plugins, encryptionKey })
// ---------------------------------------------------------------------------

export { makePostgresStorage, migratePostgresStorage } from "./executor-storage";
export type { DrizzleDb } from "./types";
