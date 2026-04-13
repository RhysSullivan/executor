// ---------------------------------------------------------------------------
// Postgres-backed PolicyEngine
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { eq, and } from "drizzle-orm";

import {
  Policy,
  PolicyId,
  PolicyNotFoundError,
  ScopeId,
  evaluatePolicyDecision,
  sortPoliciesByPrecedence,
} from "@executor/sdk";
import type { DrizzleDb } from "./types";
import type { CreatePolicyInput, PolicyCheckInput, UpdatePolicyPayload } from "@executor/sdk";

import { policies } from "./schema";

export const makePgPolicyEngine = (db: DrizzleDb, organizationId: string) => {
  let counter = 0;

  const toPolicy = (scopeId: ScopeId, row: typeof policies.$inferSelect) =>
    new Policy({
      id: PolicyId.make(row.id),
      scopeId,
      toolPattern: row.toolPattern,
      effect: row.effect as "allow" | "deny",
      approvalMode: row.approvalMode as "auto" | "required",
      priority: row.priority,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

  return {
    list: (scopeId: ScopeId) =>
      Effect.tryPromise(async () => {
        const rows = await db
          .select()
          .from(policies)
          .where(eq(policies.organizationId, organizationId));
        return sortPoliciesByPrecedence(rows.map((row) => toPolicy(scopeId, row)));
      }).pipe(Effect.orDie),

    get: (policyId: PolicyId) =>
      Effect.tryPromise(async () => {
        const [row] = await db
          .select()
          .from(policies)
          .where(and(eq(policies.id, policyId), eq(policies.organizationId, organizationId)))
          .limit(1);
        if (!row) {
          throw new PolicyNotFoundError({ policyId });
        }
        return toPolicy(ScopeId.make(organizationId), row);
      }).pipe(
        Effect.catchAll((error) =>
          error instanceof PolicyNotFoundError ? Effect.fail(error) : Effect.die(error),
        ),
      ),

    check: (input: PolicyCheckInput) =>
      Effect.tryPromise(async () => {
        const rows = await db
          .select()
          .from(policies)
          .where(eq(policies.organizationId, organizationId));
        return evaluatePolicyDecision(
          rows.map((row) => toPolicy(input.scopeId, row)),
          input,
        );
      }).pipe(Effect.orDie),

    add: (policy: CreatePolicyInput) =>
      Effect.tryPromise(async () => {
        counter += 1;
        const id = PolicyId.make(`policy-${Date.now()}-${counter}`);
        const now = new Date();
        await db.insert(policies).values({
          id,
          organizationId,
          toolPattern: policy.toolPattern,
          effect: policy.effect,
          approvalMode: policy.approvalMode,
          priority: policy.priority,
          enabled: policy.enabled,
          createdAt: now,
          updatedAt: now,
        });
        return new Policy({ ...policy, id, createdAt: now, updatedAt: now });
      }).pipe(Effect.orDie),

    update: (policyId: PolicyId, patch: UpdatePolicyPayload) =>
      Effect.tryPromise(async () => {
        const [row] = await db
          .select()
          .from(policies)
          .where(and(eq(policies.id, policyId), eq(policies.organizationId, organizationId)))
          .limit(1);
        if (!row) {
          throw new PolicyNotFoundError({ policyId });
        }

        const next = {
          toolPattern: patch.toolPattern ?? row.toolPattern,
          effect: patch.effect ?? row.effect,
          approvalMode: patch.approvalMode ?? row.approvalMode,
          priority: patch.priority ?? row.priority,
          enabled: patch.enabled ?? row.enabled,
          updatedAt: new Date(),
        };

        const [updated] = await db
          .update(policies)
          .set(next)
          .where(and(eq(policies.id, policyId), eq(policies.organizationId, organizationId)))
          .returning();

        if (!updated) {
          throw new PolicyNotFoundError({ policyId });
        }

        return toPolicy(ScopeId.make(organizationId), updated);
      }).pipe(
        Effect.catchAll((error) =>
          error instanceof PolicyNotFoundError ? Effect.fail(error) : Effect.die(error),
        ),
      ),

    remove: (policyId: PolicyId) =>
      Effect.tryPromise(async () => {
        const result = await db
          .delete(policies)
          .where(and(eq(policies.id, policyId), eq(policies.organizationId, organizationId)))
          .returning();
        return result.length > 0;
      }).pipe(Effect.orDie),
  };
};
