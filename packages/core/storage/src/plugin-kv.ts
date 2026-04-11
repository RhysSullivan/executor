// ---------------------------------------------------------------------------
// ScopedKv — opaque-state escape hatch for plugins
//
// Returned by `ctx.pluginKv(namespace)`. Backed by the core `pluginKv`
// model in `ExecutorStorage`. Plugins use this when they want simple
// key/value state without declaring their own schema.
// ---------------------------------------------------------------------------

import type { Effect } from "effect";

export interface KvEntry {
  readonly key: string;
  readonly value: string;
}

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
