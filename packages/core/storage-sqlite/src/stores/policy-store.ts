import { Effect } from "effect";
import { and, desc, eq } from "drizzle-orm";

import { StoreQueryError, policyToRow, rowToPolicy, type PolicyStore } from "@executor/storage";
import type { Policy, PolicyId, ScopeId } from "@executor/storage";

import type { DrizzleDb } from "../db";
import { policies } from "../schema";

const tryQuery = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new StoreQueryError({
        store: "policy",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.orDie);

export const makeSqlitePolicyStore = (db: DrizzleDb): PolicyStore => ({
  findByScope: (scopeId: ScopeId) =>
    tryQuery(async () =>
      db
        .select()
        .from(policies)
        .where(eq(policies.scopeId, scopeId as string))
        .orderBy(desc(policies.priority)),
    ).pipe(Effect.map((rows) => rows.map((row) => rowToPolicy(row, scopeId)))),

  create: (policy: Policy) =>
    tryQuery(async () => db.insert(policies).values(policyToRow(policy))).pipe(Effect.asVoid),

  deleteById: (id: PolicyId, scopeId: ScopeId) =>
    tryQuery(async () =>
      db
        .delete(policies)
        .where(and(eq(policies.id, id as string), eq(policies.scopeId, scopeId as string)))
        .returning({ id: policies.id }),
    ).pipe(Effect.map((rows) => rows.length > 0)),
});
