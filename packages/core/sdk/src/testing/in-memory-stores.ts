// ---------------------------------------------------------------------------
// In-memory Map-backed stores for sdk's own tests and the Promise API wrapper.
//
// NOT published as a public helper — plugins and apps should use
// `@executor/storage-sqlite/memory` for a fully-functional in-memory backend.
// This helper exists purely to avoid a dev-dep cycle between sdk and
// storage-sqlite. It implements just enough of each store interface for
// smoke-testing.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { ScopeId } from "../ids";
import type { KvEntry } from "../plugin-kv";
import type { Policy } from "../policies";
import { Scope } from "../scope";
import type { SecretProvider } from "../secrets";
import type { PluginKvStore } from "../stores/plugin-kv-store";
import type { PolicyStore } from "../stores/policy-store";
import type { SecretRow, SecretStore } from "../stores/secret-store";
import type { ToolStore } from "../stores/tool-store";
import type { ToolRegistration } from "../tools";

export interface InMemoryStores {
  readonly tools: ToolStore;
  readonly secrets: SecretStore;
  readonly policies: PolicyStore;
  readonly pluginKv: PluginKvStore;
}

export interface InMemoryConfigOptions {
  readonly cwd?: string;
  readonly scopeId?: string;
  readonly encryptionKey?: string;
  readonly secretProviders?: readonly SecretProvider[];
}

/**
 * Build a fully-spreadable executor config bundle backed by Map-based stores.
 * Intended for sdk's own tests and the Promise API wrapper. Not a published helper.
 *
 * Usage:
 * ```ts
 * const config = yield* makeInMemoryConfig({ cwd: "/test" });
 * const executor = yield* createExecutor({ ...config, plugins: [...] });
 * ```
 */
export const makeInMemoryConfig = (options?: InMemoryConfigOptions) =>
  Effect.sync(() => {
    const scope = new Scope({
      id: ScopeId.make(options?.scopeId ?? "test-scope"),
      name: options?.cwd ?? "/test",
      createdAt: new Date(),
    });
    return {
      scope,
      stores: makeInMemoryStores(),
      encryptionKey: options?.encryptionKey ?? "test-encryption-key",
      secretProviders: options?.secretProviders,
    };
  });

const key = (scopeId: string, id: string) => `${scopeId}\u0000${id}`;
const kvKey = (scopeId: string, namespace: string, k: string) =>
  `${scopeId}\u0000${namespace}\u0000${k}`;

export const makeInMemoryStores = (): InMemoryStores => {
  const toolRows = new Map<string, { scopeId: string; tool: ToolRegistration }>();
  const toolDefs = new Map<string, Record<string, unknown>>(); // scopeId -> defs record
  const secretRows = new Map<string, SecretRow>();
  const policyRows = new Map<string, Policy>();
  const kvRows = new Map<string, KvEntry & { scopeId: string; namespace: string }>();

  const tools: ToolStore = {
    findById: (id, scopeId) =>
      Effect.sync(() => {
        const row = toolRows.get(key(scopeId, id));
        return row ? row.tool : null;
      }),

    findByScope: (scopeId) =>
      Effect.sync(() => {
        const result: ToolRegistration[] = [];
        for (const row of toolRows.values()) {
          if (row.scopeId === scopeId) result.push(row.tool);
        }
        return result;
      }),

    upsert: (batch, scopeId) =>
      Effect.sync(() => {
        for (const tool of batch) {
          toolRows.set(key(scopeId, tool.id), { scopeId, tool });
        }
      }),

    deleteByIds: (ids, scopeId) =>
      Effect.sync(() => {
        for (const id of ids) toolRows.delete(key(scopeId, id));
      }),

    deleteBySource: (sourceId, scopeId) =>
      Effect.sync(() => {
        for (const [k, row] of toolRows) {
          if (row.scopeId === scopeId && row.tool.sourceId === sourceId) {
            toolRows.delete(k);
          }
        }
      }),

    findDefinitions: (scopeId) =>
      Effect.sync(() => toolDefs.get(scopeId) ?? {}),

    upsertDefinitions: (defs, scopeId) =>
      Effect.sync(() => {
        const existing = toolDefs.get(scopeId) ?? {};
        toolDefs.set(scopeId, { ...existing, ...defs });
      }),
  };

  const secrets: SecretStore = {
    findById: (id, scopeId) =>
      Effect.sync(() => secretRows.get(key(scopeId, id)) ?? null),

    findByScope: (scopeId) =>
      Effect.sync(() => {
        const result: SecretRow[] = [];
        for (const row of secretRows.values()) {
          if (row.scopeId === scopeId) result.push(row);
        }
        return result;
      }),

    upsert: (row) =>
      Effect.sync(() => {
        secretRows.set(key(row.scopeId, row.id), row);
      }),

    deleteById: (id, scopeId) =>
      Effect.sync(() => secretRows.delete(key(scopeId, id))),
  };

  const policies: PolicyStore = {
    findByScope: (scopeId) =>
      Effect.sync(() => {
        const result: Policy[] = [];
        for (const row of policyRows.values()) {
          if (row.scopeId === scopeId) result.push(row);
        }
        return result;
      }),

    create: (policy) =>
      Effect.sync(() => {
        policyRows.set(key(policy.scopeId, policy.id), policy);
      }),

    deleteById: (id, scopeId) =>
      Effect.sync(() => policyRows.delete(key(scopeId, id))),
  };

  const pluginKv: PluginKvStore = {
    get: (scopeId, namespace, k) =>
      Effect.sync(() => kvRows.get(kvKey(scopeId, namespace, k))?.value ?? null),

    list: (scopeId, namespace) =>
      Effect.sync(() => {
        const result: KvEntry[] = [];
        for (const row of kvRows.values()) {
          if (row.scopeId === scopeId && row.namespace === namespace) {
            result.push({ key: row.key, value: row.value });
          }
        }
        return result;
      }),

    upsert: (scopeId, namespace, entries) =>
      Effect.sync(() => {
        for (const entry of entries) {
          kvRows.set(kvKey(scopeId, namespace, entry.key), {
            ...entry,
            scopeId,
            namespace,
          });
        }
      }),

    deleteKeys: (scopeId, namespace, keys) =>
      Effect.sync(() => {
        let deleted = 0;
        for (const k of keys) {
          if (kvRows.delete(kvKey(scopeId, namespace, k))) deleted++;
        }
        return deleted;
      }),

    deleteAll: (scopeId, namespace) =>
      Effect.sync(() => {
        let deleted = 0;
        for (const [k, row] of kvRows) {
          if (row.scopeId === scopeId && row.namespace === namespace) {
            kvRows.delete(k);
            deleted++;
          }
        }
        return deleted;
      }),
  };

  return { tools, secrets, policies, pluginKv };
};
