import { Context, Effect, Schema } from "effect";

import { PolicyNotFoundError } from "./errors";
import { PolicyId, ScopeId, ToolId } from "./ids";

export const PolicyEffect = Schema.Literal("allow", "deny");
export type PolicyEffect = typeof PolicyEffect.Type;

export const PolicyApprovalMode = Schema.Literal("auto", "required");
export type PolicyApprovalMode = typeof PolicyApprovalMode.Type;

export class Policy extends Schema.Class<Policy>("Policy")({
  id: PolicyId,
  scopeId: ScopeId,
  toolPattern: Schema.String,
  effect: PolicyEffect,
  approvalMode: PolicyApprovalMode,
  priority: Schema.Number,
  enabled: Schema.Boolean,
  createdAt: Schema.DateFromNumber,
  updatedAt: Schema.DateFromNumber,
}) {}

export class PolicyCheckInput extends Schema.Class<PolicyCheckInput>("PolicyCheckInput")({
  scopeId: ScopeId,
  toolId: ToolId,
}) {}

export const CreatePolicyPayload = Schema.Struct({
  toolPattern: Schema.String,
  effect: PolicyEffect,
  approvalMode: PolicyApprovalMode,
  priority: Schema.Number,
  enabled: Schema.Boolean,
});
export type CreatePolicyPayload = typeof CreatePolicyPayload.Type;

export type CreatePolicyInput = CreatePolicyPayload & {
  readonly scopeId: ScopeId;
};

export const UpdatePolicyPayload = Schema.Struct({
  toolPattern: Schema.optional(Schema.String),
  effect: Schema.optional(PolicyEffect),
  approvalMode: Schema.optional(PolicyApprovalMode),
  priority: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean),
});
export type UpdatePolicyPayload = typeof UpdatePolicyPayload.Type;

export class PolicyDecision extends Schema.Class<PolicyDecision>("PolicyDecision")({
  kind: Schema.Literal("allow", "deny", "require_interaction", "fallback"),
  matchedPolicyId: Schema.NullOr(PolicyId),
  reason: Schema.String,
}) {}

export class PolicyEngine extends Context.Tag("@executor/sdk/PolicyEngine")<
  PolicyEngine,
  {
    readonly list: (scopeId: ScopeId) => Effect.Effect<readonly Policy[]>;
    readonly get: (policyId: PolicyId) => Effect.Effect<Policy, PolicyNotFoundError>;
    readonly check: (input: PolicyCheckInput) => Effect.Effect<PolicyDecision>;
    readonly add: (policy: CreatePolicyInput) => Effect.Effect<Policy>;
    readonly update: (
      policyId: PolicyId,
      patch: UpdatePolicyPayload,
    ) => Effect.Effect<Policy, PolicyNotFoundError>;
    readonly remove: (policyId: PolicyId) => Effect.Effect<boolean>;
  }
>() {}
