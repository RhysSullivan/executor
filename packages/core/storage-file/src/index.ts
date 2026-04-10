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

import { createHash } from "node:crypto";
import { basename } from "node:path";

import { scopeKv, ScopeId, makeInMemorySourceRegistry } from "@executor/sdk";
import type { Kv, Scope, ExecutorConfig, ExecutorPlugin } from "@executor/sdk";

import { makeKvToolRegistry } from "./tool-registry";
import { makeKvSecretStore } from "./secret-store";
import { makeKvPolicyEngine } from "./policy-engine";

/**
 * Derive a URL-safe scope ID from a folder path.
 * Format: `foldername-shortHash` e.g. `my-project-a1b2c3d4`
 */
const makeScopeId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

export { makeSqliteKv, makeInMemoryKv } from "./plugin-kv";
export { makeKvToolRegistry } from "./tool-registry";
export { makeKvSecretStore } from "./secret-store";
export { makeKvPolicyEngine } from "./policy-engine";
export { migrate } from "./schema";

// ---------------------------------------------------------------------------
// Convenience: build a full ExecutorConfig from a Kv instance
// ---------------------------------------------------------------------------

export const makeKvConfig = <const TPlugins extends readonly ExecutorPlugin<string, object>[] = []>(
  kv: Kv,
  options: {
    readonly cwd: string;
    readonly plugins?: TPlugins;
  },
): ExecutorConfig<TPlugins> => {
  const cwd = options.cwd;
  const scopeId = makeScopeId(cwd);
  const scope: Scope = {
    id: ScopeId.make(scopeId),
    name: cwd,
    createdAt: new Date(),
  };

  // Prefix all KV namespaces with the full cwd so each folder is fully isolated.
  const ns = (name: string) => `${cwd}::${name}`;

  return {
    scope,
    tools: makeKvToolRegistry(scopeKv(kv, ns("tools")), scopeKv(kv, ns("defs"))),
    sources: makeInMemorySourceRegistry(),
    secrets: makeKvSecretStore(scopeKv(kv, ns("secrets"))),
    policies: makeKvPolicyEngine(scopeKv(kv, ns("policies")), scopeKv(kv, ns("meta"))),
    plugins: options?.plugins,
  };
};

/**
 * Create a scoped Kv that prefixes all namespaces with the given folder path.
 * Used by plugins that need their own KV namespace scoped to a folder.
 */
export const makeScopedKv = (kv: Kv, folder: string): Kv => ({
  get: (namespace, key) => kv.get(`${folder}::${namespace}`, key),
  set: (namespace, entries) => kv.set(`${folder}::${namespace}`, entries),
  delete: (namespace, keys) => kv.delete(`${folder}::${namespace}`, keys),
  list: (namespace) => kv.list(`${folder}::${namespace}`),
  deleteAll: (namespace) => kv.deleteAll(`${folder}::${namespace}`),
  withTransaction: kv.withTransaction,
});
