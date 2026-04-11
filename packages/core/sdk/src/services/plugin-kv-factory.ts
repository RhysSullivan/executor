// ---------------------------------------------------------------------------
// makePluginKvFactory — returns a (namespace: string) => ScopedKv factory
// backed by a PluginKvStore.
//
// Ports from storage-stores/plugin-kv.ts, replacing ExecutorStorage calls
// with typed PluginKvStore methods.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type { Scope } from "../scope";
import type { ScopedKv } from "../plugin-kv";
import type { PluginKvStore } from "../stores/plugin-kv-store";

export const makePluginKvFactory = (
  store: PluginKvStore,
  scope: Scope,
): ((namespace: string) => ScopedKv) => {
  const scopeId = scope.id;

  return (namespace: string): ScopedKv => ({
    get: (key) => store.get(scopeId, namespace, key),

    set: (entries) => store.upsert(scopeId, namespace, entries),

    delete: (keys) => {
      if (keys.length === 0) return Effect.succeed(0);
      return store.deleteKeys(scopeId, namespace, keys as readonly string[]);
    },

    list: () => store.list(scopeId, namespace),

    deleteAll: () => store.deleteAll(scopeId, namespace),
  });
};
