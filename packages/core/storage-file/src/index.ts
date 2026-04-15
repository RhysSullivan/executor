// ---------------------------------------------------------------------------
// @executor/storage-file
//
// SQLite-backed DBAdapter implementation for the executor storage-core
// interface. Provides a single factory, `makeSqliteAdapter`, that takes a
// SqlClient (typically from @effect/sql-sqlite-bun or sql-sqlite-node)
// and a DBSchema, auto-generates the corresponding tables, and returns a
// DBAdapter ready to be handed to the SDK.
//
// Usage:
//
//   import { SqliteClient } from "@effect/sql-sqlite-bun"
//   import * as SqlClient from "@effect/sql/SqlClient"
//   import { makeSqliteAdapter } from "@executor/storage-file"
//
//   const program = Effect.gen(function* () {
//     const sql = yield* SqlClient.SqlClient
//     const adapter = yield* makeSqliteAdapter({ sql, schema })
//     // ...hand `adapter` to the SDK
//   }).pipe(Effect.provide(SqliteClient.layer({ filename: "data.db" })))
// ---------------------------------------------------------------------------

export { makeSqliteAdapter, type MakeSqliteAdapterOptions } from "./adapter";
