// ---------------------------------------------------------------------------
// @executor/storage-postgres
//
// Postgres-backed storage primitives for the executor runtime. Thin
// wrapper around @executor/storage-drizzle.
// ---------------------------------------------------------------------------

export {
  makePostgresAdapter,
  type MakePostgresAdapterOptions,
} from "./adapter";

export { makePostgresBlobStore, blobTable } from "./blob-store";
