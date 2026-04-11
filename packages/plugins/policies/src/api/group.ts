import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { Policy, PolicyId, PolicyNotFoundError, ScopeId, CreatePolicyPayload, UpdatePolicyPayload } from "@executor/sdk";

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const policyIdParam = HttpApiSchema.param("policyId", PolicyId);

const InvalidPolicyPayloadError = Schema.TaggedStruct("InvalidPolicyPayloadError", {
  message: Schema.String,
}).annotations(HttpApiSchema.annotations({ status: 400 }));

const PolicyNotFound = PolicyNotFoundError.annotations(HttpApiSchema.annotations({ status: 404 }));

export class PoliciesGroup extends HttpApiGroup.make("policies")
  .add(
    HttpApiEndpoint.get("list")`/scopes/${scopeIdParam}/policies`.addSuccess(Schema.Array(Policy)),
  )
  .add(
    HttpApiEndpoint.post("create")`/scopes/${scopeIdParam}/policies`
      .setPayload(CreatePolicyPayload)
      .addSuccess(Policy)
      .addError(InvalidPolicyPayloadError),
  )
  .add(
    HttpApiEndpoint.get("get")`/scopes/${scopeIdParam}/policies/${policyIdParam}`
      .addSuccess(Policy)
      .addError(PolicyNotFound),
  )
  .add(
    HttpApiEndpoint.patch("update")`/scopes/${scopeIdParam}/policies/${policyIdParam}`
      .setPayload(UpdatePolicyPayload)
      .addSuccess(Policy)
      .addError(InvalidPolicyPayloadError)
      .addError(PolicyNotFound),
  )
  .add(
    HttpApiEndpoint.del("remove")`/scopes/${scopeIdParam}/policies/${policyIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(PolicyNotFound),
  ) {}
