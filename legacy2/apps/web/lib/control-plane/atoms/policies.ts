import { Atom } from "@effect-atom/atom";
import type { RemovePolicyResult, UpsertPolicyPayload } from "@executor-v2/management-api/policies/api";
import type { Policy, PolicyDecision, PolicyId, WorkspaceId } from "@executor-v2/schema";

import { controlPlaneClient } from "../client";
import { workspaceEntity, type EntityState } from "./entity";
import { policiesKeys, policiesMutationKeys } from "./keys";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const policiesResultByWorkspace = Atom.family(
  (workspaceId: WorkspaceId) =>
    controlPlaneClient.query("policies", "list", {
      path: { workspaceId },
      reactivityKeys: policiesKeys(workspaceId),
    }),
);

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const sortPolicies = (a: Policy, b: Policy): number => {
  const aPattern = a.toolPathPattern.toLowerCase();
  const bPattern = b.toolPathPattern.toLowerCase();
  if (aPattern === bPattern) return `${a.workspaceId}:${a.id}`.localeCompare(`${b.workspaceId}:${b.id}`);
  return aPattern.localeCompare(bPattern);
};

export const policiesByWorkspace = workspaceEntity(
  policiesResultByWorkspace,
  sortPolicies,
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const upsertPolicy = controlPlaneClient.mutation("policies", "upsert");
export const removePolicy = controlPlaneClient.mutation("policies", "remove");

// ---------------------------------------------------------------------------
// Optimistic helpers
// ---------------------------------------------------------------------------

export const optimisticUpsertPolicy = (
  currentPolicies: ReadonlyArray<Policy>,
  input: {
    workspaceId: WorkspaceId;
    policyId: PolicyId;
    toolPathPattern: string;
    decision: PolicyDecision;
  },
): ReadonlyArray<Policy> => {
  const now = Date.now();
  const existing = currentPolicies.find((p) => p.id === input.policyId);
  const nextPolicy: Policy = {
    id: input.policyId,
    workspaceId: input.workspaceId,
    toolPathPattern: input.toolPathPattern,
    decision: input.decision,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const rest = currentPolicies.filter((p) => p.id !== input.policyId);
  return [...rest, nextPolicy].sort(sortPolicies);
};

export const optimisticRemovePolicy = (
  currentPolicies: ReadonlyArray<Policy>,
  policyId: PolicyId,
): ReadonlyArray<Policy> => currentPolicies.filter((p) => p.id !== policyId);

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

export const toPolicyUpsertPayload = (input: {
  id?: PolicyId;
  toolPathPattern: string;
  decision: PolicyDecision;
}): UpsertPolicyPayload => ({
  ...(input.id ? { id: input.id } : {}),
  toolPathPattern: input.toolPathPattern,
  decision: input.decision,
});

export const toPolicyUpsertRequest = (input: {
  workspaceId: WorkspaceId;
  id?: PolicyId;
  toolPathPattern: string;
  decision: PolicyDecision;
}) => ({
  path: { workspaceId: input.workspaceId },
  payload: toPolicyUpsertPayload({
    id: input.id,
    toolPathPattern: input.toolPathPattern,
    decision: input.decision,
  }),
  reactivityKeys: policiesMutationKeys(input.workspaceId),
});

export const toPolicyRemoveRequest = (input: {
  workspaceId: WorkspaceId;
  policyId: PolicyId;
}) => ({
  path: {
    workspaceId: input.workspaceId,
    policyId: input.policyId,
  },
  reactivityKeys: policiesMutationKeys(input.workspaceId),
});

export const toPolicyRemoveResult = (result: RemovePolicyResult): boolean => result.removed;

export type PoliciesState = EntityState<Policy>;
