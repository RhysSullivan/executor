import type { Effect } from "effect";

import type { ScopeId } from "../ids";
import type { KvEntry } from "../plugin-kv";

// ---------------------------------------------------------------------------
// PluginKvStore — repository interface for plugin key-value storage
// ---------------------------------------------------------------------------

export interface PluginKvStore {
  /** Get a single value by scope, namespace, and key. Returns null if not found. */
  readonly get: (
    scopeId: ScopeId,
    namespace: string,
    key: string,
  ) => Effect.Effect<string | null>;

  /** List all entries for a scope and namespace. */
  readonly list: (
    scopeId: ScopeId,
    namespace: string,
  ) => Effect.Effect<readonly KvEntry[]>;

  /** Upsert a batch of key-value entries. */
  readonly upsert: (
    scopeId: ScopeId,
    namespace: string,
    entries: readonly KvEntry[],
  ) => Effect.Effect<void>;

  /** Delete specific keys within a scope+namespace. Returns the number of rows deleted. */
  readonly deleteKeys: (
    scopeId: ScopeId,
    namespace: string,
    keys: readonly string[],
  ) => Effect.Effect<number>;

  /** Delete all entries within a scope+namespace. Returns the number of rows deleted. */
  readonly deleteAll: (scopeId: ScopeId, namespace: string) => Effect.Effect<number>;
}
