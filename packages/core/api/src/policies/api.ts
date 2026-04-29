import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { PolicyId, ScopeId, ToolPolicyActionSchema } from "@executor/sdk";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const policyIdParam = HttpApiSchema.param("policyId", PolicyId);

// ---------------------------------------------------------------------------
// Response / payload schemas
// ---------------------------------------------------------------------------

const ToolPolicyResponse = Schema.Struct({
  id: PolicyId,
  scopeId: ScopeId,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const CreateToolPolicyPayload = Schema.Struct({
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.optional(Schema.Number),
});

const UpdateToolPolicyPayload = Schema.Struct({
  pattern: Schema.optional(Schema.String),
  action: Schema.optional(ToolPolicyActionSchema),
  position: Schema.optional(Schema.Number),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class PoliciesApi extends HttpApiGroup.make("policies")
  .add(
    HttpApiEndpoint.get("list")`/scopes/${scopeIdParam}/policies`.addSuccess(
      Schema.Array(ToolPolicyResponse),
    ),
  )
  .add(
    HttpApiEndpoint.post("create")`/scopes/${scopeIdParam}/policies`
      .setPayload(CreateToolPolicyPayload)
      .addSuccess(ToolPolicyResponse),
  )
  .add(
    HttpApiEndpoint.patch("update")`/scopes/${scopeIdParam}/policies/${policyIdParam}`
      .setPayload(UpdateToolPolicyPayload)
      .addSuccess(ToolPolicyResponse),
  )
  .add(
    HttpApiEndpoint.del("remove")`/scopes/${scopeIdParam}/policies/${policyIdParam}`.addSuccess(
      Schema.Struct({ removed: Schema.Boolean }),
    ),
  )
  .addError(InternalError) {}
