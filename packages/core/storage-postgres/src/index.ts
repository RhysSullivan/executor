// ---------------------------------------------------------------------------
// @executor-js/storage-postgres
//
// Postgres-backed storage primitives for the executor runtime. Thin
// wrapper around @executor-js/storage-drizzle.
// ---------------------------------------------------------------------------

export { makePostgresAdapter, type MakePostgresAdapterOptions } from "./adapter";

export { makePostgresBlobStore, blobTable } from "./blob-store";
