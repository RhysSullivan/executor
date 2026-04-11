// ---------------------------------------------------------------------------
// Kv — generic scoped key-value store
//
// The foundational storage primitive. Everything persists through this:
// tools, definitions, secrets, policies, plugin data. Implementations
// live in @executor/storage-file or are provided by the host.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

export interface KvEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * Global KV — requires a namespace on every call.
 * Implementations: makeSqliteKv, makeInMemoryKv
 */
export interface Kv {
  readonly get: (namespace: string, key: string) => Effect.Effect<string | null>;
  /** Batch upsert — inserts or updates one or more key-value pairs. */
  readonly set: (namespace: string, entries: readonly KvEntry[]) => Effect.Effect<void>;
  /** Batch delete — removes one or more keys. */
  readonly delete: (namespace: string, keys: readonly string[]) => Effect.Effect<number>;
  readonly list: (namespace: string) => Effect.Effect<readonly { key: string; value: string }[]>;
  readonly deleteAll: (namespace: string) => Effect.Effect<number>;
  readonly withTransaction?: <A, E>(
    effect: Effect.Effect<A, E, never>,
  ) => Effect.Effect<A, E, never>;
}

/**
 * Scoped KV — already bound to a namespace.
 * This is what stores and adapters receive.
 */
export interface ScopedKv {
  readonly get: (key: string) => Effect.Effect<string | null>;
  /** Batch upsert — inserts or updates one or more key-value pairs. */
  readonly set: (entries: readonly KvEntry[]) => Effect.Effect<void>;
  /** Batch delete — removes one or more keys. */
  readonly delete: (keys: readonly string[]) => Effect.Effect<number>;
  readonly list: () => Effect.Effect<readonly { key: string; value: string }[]>;
  readonly deleteAll: () => Effect.Effect<number>;
  readonly withTransaction?: <A, E>(
    effect: Effect.Effect<A, E, never>,
  ) => Effect.Effect<A, E, never>;
}

/**
 * Scope a Kv to a specific namespace.
 */
export const scopeKv = (kv: Kv, namespace: string): ScopedKv => ({
  get: (key) => kv.get(namespace, key),
  set: (entries) => kv.set(namespace, entries),
  delete: (keys) => kv.delete(namespace, keys),
  list: () => kv.list(namespace),
  deleteAll: () => kv.deleteAll(namespace),
  withTransaction: kv.withTransaction,
});

/**
 * In-memory ScopedKv — useful for tests and plugins that don't need persistence.
 */
export const makeInMemoryScopedKv = (): ScopedKv => {
  const store = new Map<string, string>();
  return {
    get: (key) => Effect.succeed(store.get(key) ?? null),
    set: (entries) =>
      Effect.sync(() => {
        for (const { key, value } of entries) store.set(key, value);
      }),
    delete: (keys) =>
      Effect.sync(() => {
        let count = 0;
        for (const key of keys) if (store.delete(key)) count++;
        return count;
      }),
    list: () => Effect.sync(() => [...store.entries()].map(([key, value]) => ({ key, value }))),
    deleteAll: () =>
      Effect.sync(() => {
        const n = store.size;
        store.clear();
        return n;
      }),
    withTransaction: (effect) => effect,
  };
};
