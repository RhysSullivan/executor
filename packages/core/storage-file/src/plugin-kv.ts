// ---------------------------------------------------------------------------
// Kv implementations — SQLite and in-memory
// ---------------------------------------------------------------------------

import { Effect, Exit } from "effect";
import type * as SqlClient from "@effect/sql/SqlClient";
import type { Kv } from "@executor/core";

import { absorbSql } from "./sql-utils";

// ---------------------------------------------------------------------------
// SQLite implementation — single `kv` table for everything
// ---------------------------------------------------------------------------

interface KvRow {
  namespace: string;
  key: string;
  value: string;
}

export const makeSqliteKv = (sql: SqlClient.SqlClient): Kv => ({
  get: (namespace, key) =>
    absorbSql(Effect.gen(function* () {
      const rows = yield* sql<KvRow>`
        SELECT value FROM kv WHERE namespace = ${namespace} AND key = ${key}
      `;
      return rows[0]?.value ?? null;
    })),

  set: (namespace, key, value) =>
    absorbSql(sql`
      INSERT OR REPLACE INTO kv (namespace, key, value)
      VALUES (${namespace}, ${key}, ${value})
    `.pipe(Effect.asVoid)),

  delete: (namespace, key) =>
    absorbSql(Effect.gen(function* () {
      const before = yield* sql<{ c: number }>`
        SELECT COUNT(*) as c FROM kv WHERE namespace = ${namespace} AND key = ${key}
      `;
      yield* sql`DELETE FROM kv WHERE namespace = ${namespace} AND key = ${key}`;
      return (before[0]?.c ?? 0) > 0;
    })),

  list: (namespace) =>
    absorbSql(Effect.gen(function* () {
      const rows = yield* sql<KvRow>`
        SELECT key, value FROM kv WHERE namespace = ${namespace}
      `;
      return rows.map((r) => ({ key: r.key, value: r.value }));
    })),

  deleteAll: (namespace) =>
    absorbSql(Effect.gen(function* () {
      const before = yield* sql<{ c: number }>`
        SELECT COUNT(*) as c FROM kv WHERE namespace = ${namespace}
      `;
      yield* sql`DELETE FROM kv WHERE namespace = ${namespace}`;
      return before[0]?.c ?? 0;
    })),

  withTransaction: <A, E>(effect: Effect.Effect<A, E, never>) =>
    absorbSql(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* sql`BEGIN`;
          const exit = yield* restore(effect).pipe(Effect.exit);

          if (Exit.isSuccess(exit)) {
            yield* sql`COMMIT`;
          } else {
            yield* sql`ROLLBACK`;
          }

          return yield* Exit.matchEffect(exit, {
            onFailure: Effect.failCause,
            onSuccess: Effect.succeed,
          });
        }),
      ),
    ),
});

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export const makeInMemoryKv = (): Kv => {
  const store = new Map<string, Map<string, string>>();

  const bucket = (namespace: string) => {
    let m = store.get(namespace);
    if (!m) { m = new Map(); store.set(namespace, m); }
    return m;
  };

  return {
    get: (namespace, key) =>
      Effect.succeed(bucket(namespace).get(key) ?? null),

    set: (namespace, key, value) =>
      Effect.sync(() => { bucket(namespace).set(key, value); }),

    delete: (namespace, key) =>
      Effect.sync(() => bucket(namespace).delete(key)),

    list: (namespace) =>
      Effect.sync(() =>
        [...bucket(namespace).entries()].map(([key, value]) => ({ key, value })),
      ),

    deleteAll: (namespace) =>
      Effect.sync(() => {
        const m = store.get(namespace);
        const count = m?.size ?? 0;
        store.delete(namespace);
        return count;
      }),

    withTransaction: (effect) => effect,
  };
};
