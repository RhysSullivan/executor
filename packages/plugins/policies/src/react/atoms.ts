import type { ScopeId, PolicyId } from "@executor/sdk";
import { PoliciesClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const policiesAtom = (scopeId: ScopeId) =>
  PoliciesClient.query("policies", "list", {
    path: { scopeId },
    timeToLive: "15 seconds",
  });

export const policyAtom = (scopeId: ScopeId, policyId: PolicyId) =>
  PoliciesClient.query("policies", "get", {
    path: { scopeId, policyId },
    timeToLive: "15 seconds",
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const createPolicy = PoliciesClient.mutation("policies", "create");

export const updatePolicy = PoliciesClient.mutation("policies", "update");

export const removePolicy = PoliciesClient.mutation("policies", "remove");
