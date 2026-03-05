import { type SourceStoreError } from "@executor-v2/persistence-ports";
import { type Policy, type PolicyId, type WorkspaceId } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import type { RemovePolicyResult, UpsertPolicyPayload } from "./api";

export type UpsertPolicyInput = {
  workspaceId: WorkspaceId;
  payload: UpsertPolicyPayload;
};

export type RemovePolicyInput = {
  workspaceId: WorkspaceId;
  policyId: PolicyId;
};

export type ControlPlanePoliciesServiceShape = {
  listPolicies: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Policy>, SourceStoreError>;
  upsertPolicy: (
    input: UpsertPolicyInput,
  ) => Effect.Effect<Policy, SourceStoreError>;
  removePolicy: (
    input: RemovePolicyInput,
  ) => Effect.Effect<RemovePolicyResult, SourceStoreError>;
};

export const makeControlPlanePoliciesService = (
  service: ControlPlanePoliciesServiceShape,
): ControlPlanePoliciesServiceShape => service;
