import { Effect } from "effect";
import { and, eq, inArray, sql } from "drizzle-orm";

import { StoreQueryError, type PluginKvStore } from "@executor/sdk";
import type { KvEntry, ScopeId } from "@executor/sdk";

import type { DrizzleDb } from "../db";
import { pluginKv } from "../schema";

const tryQuery = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new StoreQueryError({
        store: "plugin_kv",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.orDie);

export const makeSqlitePluginKvStore = (db: DrizzleDb): PluginKvStore => ({
  get: (scopeId: ScopeId, namespace: string, key: string) =>
    tryQuery(async () =>
      db
        .select({ value: pluginKv.value })
        .from(pluginKv)
        .where(
          and(
            eq(pluginKv.scopeId, scopeId as string),
            eq(pluginKv.namespace, namespace),
            eq(pluginKv.key, key),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]?.value ?? null)),

  list: (scopeId: ScopeId, namespace: string) =>
    tryQuery(async () =>
      db
        .select({ key: pluginKv.key, value: pluginKv.value })
        .from(pluginKv)
        .where(and(eq(pluginKv.scopeId, scopeId as string), eq(pluginKv.namespace, namespace))),
    ).pipe(Effect.map((rows): readonly KvEntry[] => rows)),

  upsert: (scopeId: ScopeId, namespace: string, entries: readonly KvEntry[]) => {
    if (entries.length === 0) return Effect.void;
    return tryQuery(async () =>
      db
        .insert(pluginKv)
        .values(
          entries.map((e) => ({
            scopeId: scopeId as string,
            namespace,
            key: e.key,
            value: e.value,
          })),
        )
        .onConflictDoUpdate({
          target: [pluginKv.scopeId, pluginKv.namespace, pluginKv.key],
          set: { value: sql`excluded.value` },
        }),
    ).pipe(Effect.asVoid);
  },

  deleteKeys: (scopeId: ScopeId, namespace: string, keys: readonly string[]) => {
    if (keys.length === 0) return Effect.succeed(0);
    return tryQuery(async () =>
      db
        .delete(pluginKv)
        .where(
          and(
            eq(pluginKv.scopeId, scopeId as string),
            eq(pluginKv.namespace, namespace),
            inArray(pluginKv.key, [...keys]),
          ),
        )
        .returning({ key: pluginKv.key }),
    ).pipe(Effect.map((rows) => rows.length));
  },

  deleteAll: (scopeId: ScopeId, namespace: string) =>
    tryQuery(async () =>
      db
        .delete(pluginKv)
        .where(and(eq(pluginKv.scopeId, scopeId as string), eq(pluginKv.namespace, namespace)))
        .returning({ key: pluginKv.key }),
    ).pipe(Effect.map((rows) => rows.length)),
});
