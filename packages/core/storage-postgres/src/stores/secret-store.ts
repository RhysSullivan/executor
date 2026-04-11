import { Effect } from "effect";
import { and, eq } from "drizzle-orm";

import { StoreQueryError, type SecretStore, type SecretRow } from "@executor/sdk";
import type { SecretId, ScopeId } from "@executor/sdk";

import type { DrizzleDb } from "../db";
import { secrets } from "../schema";
import { buildConflictUpdateAllColumns } from "../helpers/build-conflict-update";

const tryQuery = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new StoreQueryError({
        store: "secret",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.orDie);

const rowToSecretRow = (row: typeof secrets.$inferSelect): SecretRow => ({
  id: row.id,
  scopeId: row.scopeId,
  name: row.name,
  purpose: row.purpose,
  provider: row.provider,
  encryptedValue: row.encryptedValue,
  iv: row.iv,
  createdAt: row.createdAt,
});

export const makePostgresSecretStore = (db: DrizzleDb): SecretStore => ({
  findById: (id: SecretId, scopeId: ScopeId) =>
    tryQuery(() =>
      db
        .select()
        .from(secrets)
        .where(and(eq(secrets.id, id as string), eq(secrets.scopeId, scopeId as string)))
        .limit(1),
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row ? rowToSecretRow(row) : null;
      }),
    ),

  findByScope: (scopeId: ScopeId) =>
    tryQuery(() =>
      db
        .select()
        .from(secrets)
        .where(eq(secrets.scopeId, scopeId as string)),
    ).pipe(Effect.map((rows) => rows.map(rowToSecretRow))),

  upsert: (row: SecretRow) =>
    tryQuery(() =>
      db
        .insert(secrets)
        .values({
          id: row.id,
          scopeId: row.scopeId,
          name: row.name,
          purpose: row.purpose ?? null,
          provider: row.provider ?? null,
          encryptedValue: row.encryptedValue ? Buffer.from(row.encryptedValue) : null,
          iv: row.iv ? Buffer.from(row.iv) : null,
          createdAt: row.createdAt,
        })
        .onConflictDoUpdate({
          target: [secrets.id, secrets.scopeId],
          set: buildConflictUpdateAllColumns(secrets, ["id", "scopeId", "createdAt"]),
        }),
    ).pipe(Effect.asVoid),

  deleteById: (id: SecretId, scopeId: ScopeId) =>
    tryQuery(() =>
      db
        .delete(secrets)
        .where(and(eq(secrets.id, id as string), eq(secrets.scopeId, scopeId as string)))
        .returning({ id: secrets.id }),
    ).pipe(Effect.map((rows) => rows.length > 0)),
});
