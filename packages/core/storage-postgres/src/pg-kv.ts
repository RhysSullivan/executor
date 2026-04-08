// ---------------------------------------------------------------------------
// Postgres-backed Kv — uses plugin_kv table, scoped by team_id
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { eq, and } from "drizzle-orm";
import type { Kv } from "@executor/core";

import { pluginKv } from "./schema";
import type { DrizzleDb } from "./types";

export const makePgKv = (db: DrizzleDb, teamId: string): Kv => ({
  get: (namespace, key) =>
    Effect.tryPromise(async () => {
      const rows = await db
        .select({ value: pluginKv.value })
        .from(pluginKv)
        .where(
          and(
            eq(pluginKv.teamId, teamId),
            eq(pluginKv.namespace, namespace),
            eq(pluginKv.key, key),
          ),
        );
      return rows[0]?.value ?? null;
    }).pipe(Effect.orDie),

  set: (namespace, key, value) =>
    Effect.tryPromise(async () => {
      await db
        .insert(pluginKv)
        .values({ teamId, namespace, key, value })
        .onConflictDoUpdate({
          target: [pluginKv.teamId, pluginKv.namespace, pluginKv.key],
          set: { value },
        });
    }).pipe(Effect.orDie),

  delete: (namespace, key) =>
    Effect.tryPromise(async () => {
      const result = await db
        .delete(pluginKv)
        .where(
          and(
            eq(pluginKv.teamId, teamId),
            eq(pluginKv.namespace, namespace),
            eq(pluginKv.key, key),
          ),
        )
        .returning();
      return result.length > 0;
    }).pipe(Effect.orDie),

  list: (namespace) =>
    Effect.tryPromise(async () => {
      const rows = await db
        .select({ key: pluginKv.key, value: pluginKv.value })
        .from(pluginKv)
        .where(
          and(
            eq(pluginKv.teamId, teamId),
            eq(pluginKv.namespace, namespace),
          ),
        );
      return rows;
    }).pipe(Effect.orDie),

  deleteAll: (namespace) =>
    Effect.tryPromise(async () => {
      const result = await db
        .delete(pluginKv)
        .where(
          and(
            eq(pluginKv.teamId, teamId),
            eq(pluginKv.namespace, namespace),
          ),
        )
        .returning();
      return result.length;
    }).pipe(Effect.orDie),

  withTransaction: <A, E>(effect: Effect.Effect<A, E, never>) =>
    // Drizzle handles transactions at the query level;
    // for the KV escape hatch we just pass through
    effect,
});
