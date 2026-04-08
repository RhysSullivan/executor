// ---------------------------------------------------------------------------
// Postgres-backed PolicyEngine
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { eq, and } from "drizzle-orm";

import { Policy, PolicyId, ScopeId } from "@executor/core";
import type { DrizzleDb } from "./types";
import type { PolicyCheckInput } from "@executor/core";

import { policies } from "./schema";

export const makePgPolicyEngine = (
  db: DrizzleDb,
  teamId: string,
) => {
  let counter = 0;

  return {
    list: (scopeId: ScopeId) =>
      Effect.tryPromise(async () => {
        const rows = await db
          .select()
          .from(policies)
          .where(eq(policies.teamId, teamId));
        return rows.map(
          (row) =>
            new Policy({
              id: PolicyId.make(row.id),
              scopeId,
              name: row.name,
              action: row.action as "allow" | "deny" | "require_approval",
              match: {
                toolPattern: row.matchToolPattern ?? undefined,
                sourceId: row.matchSourceId ?? undefined,
              },
              priority: row.priority,
              createdAt: row.createdAt,
            }),
        );
      }).pipe(Effect.orDie),

    check: (_input: PolicyCheckInput) => Effect.void,

    add: (policy: Omit<Policy, "id" | "createdAt">) =>
      Effect.tryPromise(async () => {
        counter += 1;
        const id = PolicyId.make(`policy-${counter}`);
        const now = new Date();
        await db.insert(policies).values({
          id,
          teamId,
          name: policy.name,
          action: policy.action,
          matchToolPattern: policy.match.toolPattern,
          matchSourceId: policy.match.sourceId,
          priority: policy.priority,
          createdAt: now,
        });
        return new Policy({ ...policy, id, createdAt: now });
      }).pipe(Effect.orDie),

    remove: (policyId: PolicyId) =>
      Effect.tryPromise(async () => {
        const result = await db
          .delete(policies)
          .where(and(eq(policies.id, policyId), eq(policies.teamId, teamId)))
          .returning();
        return result.length > 0;
      }).pipe(Effect.orDie),
  };
};
