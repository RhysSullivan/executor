// ---------------------------------------------------------------------------
// @executor/storage-file — KV-backed storage for the executor SDK
//
// Everything persists through a single Kv interface, backed by one SQLite
// table (`kv`) with namespace + key + value columns. Each collection
// (tools, defs, secrets, policies, plugins) is a namespace.
//
// Usage:
//
//   import { makeSqliteKv, makeKvConfig } from "@executor/storage-file"
//   import { SqliteClient } from "@effect/sql-sqlite-bun"
//
//   const program = Effect.gen(function* () {
//     const sql = yield* SqlClient.SqlClient
//     const kv = makeSqliteKv(sql)
//     const config = makeKvConfig(kv, { plugins: [...] })
//     const executor = yield* createExecutor(config)
//   }).pipe(
//     Effect.provide(SqliteClient.layer({ filename: "data.db" })),
//   )
//
// ---------------------------------------------------------------------------

import { scopeKv, ScopeId, makeInMemorySourceRegistry } from "@executor/sdk";
import type { Kv, Scope, ExecutorConfig, ExecutorPlugin } from "@executor/sdk";

import { makeKvToolRegistry } from "./tool-registry";
import { makeKvSecretStore } from "./secret-store";
import { makeKvPolicyEngine } from "./policy-engine";

export { makeSqliteKv, makeInMemoryKv } from "./plugin-kv";
export { makeKvToolRegistry } from "./tool-registry";
export { makeKvSecretStore } from "./secret-store";
export { makeKvPolicyEngine } from "./policy-engine";
export { migrate } from "./schema";

// ---------------------------------------------------------------------------
// Convenience: build a full ExecutorConfig from a Kv instance
// ---------------------------------------------------------------------------

export const makeKvConfig = <
  const TPlugins extends readonly ExecutorPlugin<string, object>[] = [],
>(
  kv: Kv,
  options?: {
    readonly name?: string;
    readonly plugins?: TPlugins;
  },
): ExecutorConfig<TPlugins> => {
  const scope: Scope = {
    id: ScopeId.make("default"),
    parentId: null,
    name: options?.name ?? "default",
    createdAt: new Date(),
  };

  return {
    scope,
    tools: makeKvToolRegistry(
      scopeKv(kv, "tools"),
      scopeKv(kv, "defs"),
    ),
    sources: makeInMemorySourceRegistry(),
    secrets: makeKvSecretStore(
      scopeKv(kv, "secrets"),
    ),
    policies: makeKvPolicyEngine(
      scopeKv(kv, "policies"),
      scopeKv(kv, "meta"),
    ),
    plugins: options?.plugins,
  };
};
