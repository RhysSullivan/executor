import { Effect } from "effect";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  rowToToolRegistration,
  toolRegistrationToRow,
  StoreQueryError,
  type ToolStore,
} from "@executor/sdk";
import type { ScopeId, ToolId } from "@executor/sdk";

import type { DrizzleDb } from "../db";
import { tools, toolDefinitions } from "../schema";
import { buildConflictUpdateAllColumns } from "../helpers/build-conflict-update";

const tryQuery = <A>(store: string, fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new StoreQueryError({
        store,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.orDie);

export const makeSqliteToolStore = (db: DrizzleDb): ToolStore => ({
  findById: (id: ToolId, scopeId: ScopeId) =>
    tryQuery("tool", async () =>
      db
        .select()
        .from(tools)
        .where(and(eq(tools.id, id as string), eq(tools.scopeId, scopeId as string)))
        .limit(1),
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row ? rowToToolRegistration(row) : null;
      }),
    ),

  findByScope: (scopeId: ScopeId) =>
    tryQuery("tool", async () =>
      db
        .select()
        .from(tools)
        .where(eq(tools.scopeId, scopeId as string)),
    ).pipe(Effect.map((rows) => rows.map(rowToToolRegistration))),

  upsert: (newTools, scopeId: ScopeId) => {
    if (newTools.length === 0) return Effect.void;
    return tryQuery("tool", async () =>
      db
        .insert(tools)
        .values(newTools.map((t) => toolRegistrationToRow(t, scopeId)))
        .onConflictDoUpdate({
          target: [tools.id, tools.scopeId],
          set: buildConflictUpdateAllColumns(tools, ["id", "scopeId", "createdAt"]),
        }),
    ).pipe(Effect.asVoid);
  },

  deleteByIds: (ids: readonly ToolId[], scopeId: ScopeId) => {
    if (ids.length === 0) return Effect.void;
    return tryQuery("tool", async () =>
      db
        .delete(tools)
        .where(
          and(
            inArray(
              tools.id,
              ids.map((id) => id as string),
            ),
            eq(tools.scopeId, scopeId as string),
          ),
        ),
    ).pipe(Effect.asVoid);
  },

  deleteBySource: (sourceId: string, scopeId: ScopeId) =>
    tryQuery("tool", async () =>
      db
        .delete(tools)
        .where(and(eq(tools.sourceId, sourceId), eq(tools.scopeId, scopeId as string))),
    ).pipe(Effect.asVoid),

  findDefinitions: (scopeId: ScopeId) =>
    tryQuery("tool_definitions", async () =>
      db
        .select()
        .from(toolDefinitions)
        .where(eq(toolDefinitions.scopeId, scopeId as string)),
    ).pipe(
      Effect.map((rows) => Object.fromEntries(rows.map((r) => [r.name, r.schema]))),
    ),

  upsertDefinitions: (defs: Record<string, unknown>, scopeId: ScopeId) => {
    const entries = Object.entries(defs);
    if (entries.length === 0) return Effect.void;
    return tryQuery("tool_definitions", async () =>
      db
        .insert(toolDefinitions)
        .values(entries.map(([name, schema]) => ({ name, scopeId: scopeId as string, schema })))
        .onConflictDoUpdate({
          target: [toolDefinitions.name, toolDefinitions.scopeId],
          set: { schema: sql`excluded.schema` },
        }),
    ).pipe(Effect.asVoid);
  },
});
