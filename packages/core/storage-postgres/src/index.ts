// ---------------------------------------------------------------------------
// @executor/storage-postgres — Drizzle-backed relational storage
//
// Replaces the KV-based storage-file with proper relational tables in
// Postgres for the cloud/SaaS version. Implements the same SDK service
// interfaces so all plugins work unchanged.
//
// Usage:
//
//   import { makePgConfig, makePgKv } from "@executor/storage-postgres"
//   import { drizzle } from "drizzle-orm/node-postgres"
//   import * as schema from "@executor/storage-postgres/schema"
//
//   const db = drizzle(pool, { schema })
//   const config = makePgConfig(db, { organizationId: "...", organizationName: "..." })
//   const executor = yield* createExecutor(config)
//
// ---------------------------------------------------------------------------

import { ScopeId, makeInMemorySourceRegistry } from "@executor/sdk";
import type { Scope, ExecutorConfig, ExecutorPlugin } from "@executor/sdk";
import type { DrizzleDb } from "./types";

import { makePgToolRegistry } from "./tool-registry";
import { makePgSecretStore } from "./secret-store";
import { makePgPolicyEngine } from "./policy-engine";

export { makePgKv } from "./pg-kv";
export { makePgToolRegistry } from "./tool-registry";
export { makePgSecretStore } from "./secret-store";
export { makePgPolicyEngine } from "./policy-engine";
export { encrypt, decrypt } from "./crypto";
export type { DrizzleDb } from "./types";

// ---------------------------------------------------------------------------
// Convenience: build a full ExecutorConfig from a Drizzle DB instance
// ---------------------------------------------------------------------------

export const makePgConfig = <const TPlugins extends readonly ExecutorPlugin<string, object>[] = []>(
  db: DrizzleDb,
  options: {
    readonly organizationId: string;
    readonly organizationName: string;
    readonly encryptionKey: string;
    readonly plugins?: TPlugins;
  },
): ExecutorConfig<TPlugins> => {
  const scope: Scope = {
    id: ScopeId.make(options.organizationId),
    name: options.organizationName,
    createdAt: new Date(),
  };

  return {
    scope,
    tools: makePgToolRegistry(db, options.organizationId),
    sources: makeInMemorySourceRegistry(),
    secrets: makePgSecretStore(db, options.organizationId, options.encryptionKey),
    policies: makePgPolicyEngine(db, options.organizationId),
    plugins: options.plugins,
  };
};
