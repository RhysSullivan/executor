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
//   const config = makePgConfig(db, { teamId: "...", teamName: "..." })
//   const executor = yield* createExecutor(config)
//
// ---------------------------------------------------------------------------

import { ScopeId, makeInMemorySourceRegistry } from "@executor/core";
import type { Scope, ExecutorConfig, ExecutorPlugin } from "@executor/core";
import type { DrizzleDb } from "./types";

import { makePgToolRegistry } from "./tool-registry";
import { makePgSecretStore } from "./secret-store";
import { makePgPolicyEngine } from "./policy-engine";

export { makePgKv } from "./pg-kv";
export { makePgToolRegistry } from "./tool-registry";
export { makePgSecretStore } from "./secret-store";
export { makePgPolicyEngine } from "./policy-engine";
export { makeUserStore } from "./user-store";
export type { User, Team, TeamMember, Invitation } from "./user-store";
export { encrypt, decrypt } from "./crypto";
export type { DrizzleDb } from "./types";
export * from "./schema";

// ---------------------------------------------------------------------------
// Convenience: build a full ExecutorConfig from a Drizzle DB instance
// ---------------------------------------------------------------------------

export const makePgConfig = <
  const TPlugins extends readonly ExecutorPlugin<string, object>[] = [],
>(
  db: DrizzleDb,
  options: {
    readonly teamId: string;
    readonly teamName: string;
    readonly encryptionKey: string;
    readonly plugins?: TPlugins;
  },
): ExecutorConfig<TPlugins> => {
  const scope: Scope = {
    id: ScopeId.make(options.teamId),
    name: options.teamName,
    createdAt: new Date(),
  };

  return {
    scope,
    tools: makePgToolRegistry(db, options.teamId),
    sources: makeInMemorySourceRegistry(),
    secrets: makePgSecretStore(db, options.teamId, options.encryptionKey),
    policies: makePgPolicyEngine(db, options.teamId),
    plugins: options.plugins,
  };
};
