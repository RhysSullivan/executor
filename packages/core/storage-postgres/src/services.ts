// ---------------------------------------------------------------------------
// makePostgresStores — assemble all stores from a Postgres Drizzle instance.
//
// Migrations are NOT run here. Callers are responsible for running migrations
// externally before invoking this factory. For PGlite-based tests, use
// src/testing/pglite.ts which runs migrations automatically via drizzle-kit.
//
// Returns plain `ToolStore` / `SecretStore` / `PolicyStore` / `PluginKvStore`
// instances. Callers pass the bundle into `createExecutor({ scope, stores, ... })`.
// ---------------------------------------------------------------------------

import type { ExecutorStores } from "@executor/sdk";

import type { DrizzleDb } from "./db";
import {
  makePostgresToolStore,
  makePostgresSecretStore,
  makePostgresPolicyStore,
  makePostgresPluginKvStore,
} from "./stores";

export const makePostgresStores = (db: DrizzleDb): ExecutorStores => ({
  tools: makePostgresToolStore(db),
  secrets: makePostgresSecretStore(db),
  policies: makePostgresPolicyStore(db),
  pluginKv: makePostgresPluginKvStore(db),
});
