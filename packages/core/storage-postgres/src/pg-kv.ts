// ---------------------------------------------------------------------------
// Postgres-backed Kv — uses plugin_kv table, scoped by organization_id
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { eq, and, sql, inArray } from "drizzle-orm";
import type { Kv } from "@executor/sdk";

import { pluginKv } from "./schema";
import type { DrizzleDb } from "./types";

export const makePgKv = (db: DrizzleDb, organizationId: string): Kv => ({
  get: (namespace, key) =>
    Effect.tryPromise(async () => {
      const rows = await db
        .select({ value: pluginKv.value })
        .from(pluginKv)
        .where(
          and(
            eq(pluginKv.organizationId, organizationId),
            eq(pluginKv.namespace, namespace),
            eq(pluginKv.key, key),
          ),
        );
      return rows[0]?.value ?? null;
    }).pipe(Effect.orDie),

  set: (namespace, entries) =>
    Effect.tryPromise(async () => {
      if (entries.length === 0) return;
      const values = entries.map(({ key, value }) => ({
        organizationId,
        namespace,
        key,
        value,
      }));
      await db
        .insert(pluginKv)
        .values(values)
        .onConflictDoUpdate({
          target: [pluginKv.organizationId, pluginKv.namespace, pluginKv.key],
          set: { value: sql`excluded.value` },
        });
    }).pipe(Effect.orDie),

  delete: (namespace, keys) =>
    Effect.tryPromise(async () => {
      if (keys.length === 0) return 0;
      const result = await db
        .delete(pluginKv)
        .where(
          and(
            eq(pluginKv.organizationId, organizationId),
            eq(pluginKv.namespace, namespace),
            inArray(pluginKv.key, [...keys]),
          ),
        )
        .returning();
      return result.length;
    }).pipe(Effect.orDie),

  list: (namespace) =>
    Effect.tryPromise(async () => {
      const rows = await db
        .select({ key: pluginKv.key, value: pluginKv.value })
        .from(pluginKv)
        .where(and(eq(pluginKv.organizationId, organizationId), eq(pluginKv.namespace, namespace)));
      return rows;
    }).pipe(Effect.orDie),

  deleteAll: (namespace) =>
    Effect.tryPromise(async () => {
      const result = await db
        .delete(pluginKv)
        .where(and(eq(pluginKv.organizationId, organizationId), eq(pluginKv.namespace, namespace)))
        .returning();
      return result.length;
    }).pipe(Effect.orDie),

  withTransaction: <A, E>(effect: Effect.Effect<A, E, never>) => effect,
});
