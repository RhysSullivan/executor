import { Context, Effect, Schema } from "effect";

import { PolicyId, ScopeId, ToolId } from "./ids";
import { PolicyDeniedError } from "./errors";

export const PolicyAction = Schema.Literal("allow", "deny", "require_approval");
export type PolicyAction = typeof PolicyAction.Type;

export class Policy extends Schema.Class<Policy>("Policy")({
  id: PolicyId,
  scopeId: ScopeId,
  name: Schema.String,
  action: PolicyAction,
  match: Schema.Struct({
    toolPattern: Schema.optional(Schema.String),
    sourceId: Schema.optional(Schema.String),
  }),
  priority: Schema.Number,
  createdAt: Schema.DateFromNumber,
}) {}

export class PolicyCheckInput extends Schema.Class<PolicyCheckInput>("PolicyCheckInput")({
  scopeId: ScopeId,
  toolId: ToolId,
}) {}

export class PolicyEngine extends Context.Tag("@executor/sdk/PolicyEngine")<
  PolicyEngine,
  {
    readonly list: (scopeId: ScopeId) => Effect.Effect<readonly Policy[]>;
    readonly check: (input: PolicyCheckInput) => Effect.Effect<void, PolicyDeniedError>;
    readonly add: (
      policy: Omit<Policy, "id" | "createdAt">,
    ) => Effect.Effect<Policy>;
    readonly remove: (policyId: PolicyId) => Effect.Effect<boolean>;
  }
>() {}
