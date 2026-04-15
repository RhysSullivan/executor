// ---------------------------------------------------------------------------
// @executor/storage-postgres
//
// Postgres DBAdapter for the executor runtime. The single public export
// is makePostgresAdapter(options), which takes an @effect/sql SqlClient
// (typically a @effect/sql-pg PgClient) plus a DBSchema and returns a
// DBAdapter implementation with postgres-flavored SQL: JSONB, TIMESTAMPTZ,
// native BOOLEAN, native arrays, multi-row INSERTs via VALUES, and
// transactions via the client's withTransaction.
// ---------------------------------------------------------------------------

export {
  makePostgresAdapter,
  type MakePostgresAdapterOptions,
} from "./adapter";
