// ---------------------------------------------------------------------------
// @executor/storage-drizzle
//
// A DBAdapter implementation that delegates to drizzle-orm's cross-dialect
// query builder. Works against sqlite, postgres, and mysql — the backend
// packages (@executor/storage-file, @executor/storage-postgres) construct
// a drizzle db + table map and hand both to `drizzleAdapter`.
//
// Vendored from better-auth's drizzle adapter, adapted to our simpler
// CustomAdapter surface and Effect-based error channel.
// ---------------------------------------------------------------------------

export {
  drizzleAdapter,
  isTransientStorageError,
  type DrizzleAdapterOptions,
  type DrizzleProvider,
  type DrizzleDB,
} from "./adapter";
