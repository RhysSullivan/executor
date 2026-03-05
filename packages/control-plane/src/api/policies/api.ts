import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  PolicyIdSchema,
  PolicyInsertSchema,
  PolicySchema,
  PolicyUpdateSchema,
  WorkspaceIdSchema,
} from "#schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

export const CreatePolicyPayloadSchema = PolicyInsertSchema.pipe(
  Schema.pick(
    "resourceType",
    "resourcePattern",
    "matchType",
    "effect",
    "approvalMode",
    "argumentConditionsJson",
    "priority",
    "enabled",
    "targetAccountId",
    "clientId",
  ),
  Schema.partialWith({ exact: true }),
);

export type CreatePolicyPayload = typeof CreatePolicyPayloadSchema.Type;

export const UpdatePolicyPayloadSchema = PolicyUpdateSchema.pipe(
  Schema.pick(
    "resourceType",
    "resourcePattern",
    "matchType",
    "effect",
    "approvalMode",
    "argumentConditionsJson",
    "priority",
    "enabled",
    "targetAccountId",
    "clientId",
  ),
  Schema.partialWith({ exact: true }),
);

export type UpdatePolicyPayload = typeof UpdatePolicyPayloadSchema.Type;

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
    HttpApiEndpoint.post("create")`/workspaces/${workspaceIdParam}/policies`
      .setPayload(CreatePolicyPayloadSchema)
      .addSuccess(PolicySchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/workspaces/${workspaceIdParam}/policies/${policyIdParam}`
      .addSuccess(PolicySchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.patch("update")`/workspaces/${workspaceIdParam}/policies/${policyIdParam}`
      .setPayload(UpdatePolicyPayloadSchema)
      .addSuccess(PolicySchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/workspaces/${workspaceIdParam}/policies/${policyIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
