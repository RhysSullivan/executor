// ---------------------------------------------------------------------------
// makeSqliteStores — assemble all stores from a SQLite Drizzle instance.
//
// Returns plain store implementations. Callers pass the bundle into
// `createExecutor({ scope, stores, ... })`, which wraps them into services.
// ---------------------------------------------------------------------------

import type { ExecutorStores } from "@executor/sdk";

import type { DrizzleDb } from "./db";
import {
  makeSqliteToolStore,
  makeSqliteSecretStore,
  makeSqlitePolicyStore,
  makeSqlitePluginKvStore,
} from "./stores";

export const makeSqliteStores = (db: DrizzleDb): ExecutorStores => ({
  tools: makeSqliteToolStore(db),
  secrets: makeSqliteSecretStore(db),
  policies: makeSqlitePolicyStore(db),
  pluginKv: makeSqlitePluginKvStore(db),
});
