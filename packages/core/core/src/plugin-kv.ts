// ---------------------------------------------------------------------------
// Kv — generic scoped key-value store
//
// The foundational storage primitive. Everything persists through this:
// tools, definitions, secrets, policies, plugin data. Implementations
// live in @executor/storage-file or are provided by the host.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

/**
 * Global KV — requires a namespace on every call.
 * Implementations: makeSqliteKv, makeInMemoryKv
 */
export interface Kv {
  readonly get: (namespace: string, key: string) => Effect.Effect<string | null>;
  readonly set: (namespace: string, key: string, value: string) => Effect.Effect<void>;
  readonly delete: (namespace: string, key: string) => Effect.Effect<boolean>;
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
  readonly set: (key: string, value: string) => Effect.Effect<void>;
  readonly delete: (key: string) => Effect.Effect<boolean>;
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
  set: (key, value) => kv.set(namespace, key, value),
  delete: (key) => kv.delete(namespace, key),
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
    set: (key, value) => Effect.sync(() => { store.set(key, value); }),
    delete: (key) => Effect.sync(() => store.delete(key)),
    list: () =>
      Effect.sync(() =>
        [...store.entries()].map(([key, value]) => ({ key, value })),
      ),
    deleteAll: () =>
      Effect.sync(() => {
        const n = store.size;
        store.clear();
        return n;
      }),
    withTransaction: (effect) => effect,
  };
};
