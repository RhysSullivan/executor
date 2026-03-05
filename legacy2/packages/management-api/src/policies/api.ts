import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { PolicyIdSchema, PolicySchema, WorkspaceIdSchema } from "@executor-v2/schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

const RequiredUpsertPolicyPayloadSchema = PolicySchema.pipe(
  Schema.pick("toolPathPattern", "decision"),
);

const OptionalUpsertPolicyPayloadSchema = PolicySchema.pipe(
  Schema.pick("id"),
  Schema.partialWith({ exact: true }),
);

export const UpsertPolicyPayloadSchema = RequiredUpsertPolicyPayloadSchema.pipe(
  Schema.extend(OptionalUpsertPolicyPayloadSchema),
);

export type UpsertPolicyPayload = typeof UpsertPolicyPayloadSchema.Type;

export const RemovePolicyResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type RemovePolicyResult = typeof RemovePolicyResultSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const policyIdParam = HttpApiSchema.param("policyId", PolicyIdSchema);

export class PoliciesApi extends HttpApiGroup.make("policies")
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/policies`
      .addSuccess(Schema.Array(PolicySchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("upsert")`/workspaces/${workspaceIdParam}/policies`
      .setPayload(UpsertPolicyPayloadSchema)
      .addSuccess(PolicySchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/workspaces/${workspaceIdParam}/policies/${policyIdParam}`
      .addSuccess(RemovePolicyResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
