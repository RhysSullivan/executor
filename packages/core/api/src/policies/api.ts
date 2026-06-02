import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, PolicyId, ScopeId, ToolPolicyActionSchema } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };
const PolicyParams = { scopeId: ScopeId, policyId: PolicyId };

// ---------------------------------------------------------------------------
// Response / payload schemas
// ---------------------------------------------------------------------------

const ToolPolicyResponse = Schema.Struct({
  id: PolicyId,
  scopeId: ScopeId,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const CreateToolPolicyPayload = Schema.Struct({
  targetScope: ScopeId,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.optional(Schema.String),
});

export const UpdateToolPolicyPayload = Schema.Struct({
  targetScope: ScopeId,
  pattern: Schema.optional(Schema.String),
  action: Schema.optional(ToolPolicyActionSchema),
  position: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const PoliciesApi = HttpApiGroup.make("policies")
  .add(
    HttpApiEndpoint.get("list", "/scopes/:scopeId/policies", {
      params: ScopeParams,
      success: Schema.Array(ToolPolicyResponse),
      error: InternalError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "policies.list",
        summary: "List Policies",
        description: "Lists all tool policies for the given scope.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("create", "/scopes/:scopeId/policies", {
      params: ScopeParams,
      payload: CreateToolPolicyPayload,
      success: ToolPolicyResponse,
      error: InternalError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "policies.create",
        summary: "Create Policy",
        description:
          "Creates a tool policy targeting a scope with a pattern, action, and optional position.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("update", "/scopes/:scopeId/policies/:policyId", {
      params: PolicyParams,
      payload: UpdateToolPolicyPayload,
      success: ToolPolicyResponse,
      error: InternalError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "policies.update",
        summary: "Update Policy",
        description:
          "Updates the target scope, pattern, action, or position of an existing tool policy.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/scopes/:scopeId/policies/:policyId", {
      params: PolicyParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: InternalError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "policies.remove",
        summary: "Remove Policy",
        description: "Deletes the tool policy identified by policy ID within the given scope.",
      }),
    ),
  );
