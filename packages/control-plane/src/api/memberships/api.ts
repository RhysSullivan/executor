import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  AccountIdSchema,
  OrganizationIdSchema,
  OrganizationMembershipInsertSchema,
  OrganizationMembershipSchema,
  OrganizationMembershipUpdateSchema,
} from "#schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

const createMembershipPayloadRequiredSchema = OrganizationMembershipInsertSchema.pipe(
  Schema.pick("accountId", "role"),
);

const createMembershipPayloadOptionalSchema = OrganizationMembershipInsertSchema.pipe(
  Schema.pick("status", "billable", "invitedByAccountId"),
  Schema.partialWith({ exact: true }),
);

export const CreateMembershipPayloadSchema = Schema.extend(
  createMembershipPayloadRequiredSchema,
  createMembershipPayloadOptionalSchema,
);

export type CreateMembershipPayload = typeof CreateMembershipPayloadSchema.Type;

export const UpdateMembershipPayloadSchema = OrganizationMembershipUpdateSchema.pipe(
  Schema.pick("role", "status", "billable"),
  Schema.partialWith({ exact: true }),
);

export type UpdateMembershipPayload = typeof UpdateMembershipPayloadSchema.Type;

const organizationIdParam = HttpApiSchema.param("organizationId", OrganizationIdSchema);
const accountIdParam = HttpApiSchema.param("accountId", AccountIdSchema);

export class MembershipsApi extends HttpApiGroup.make("memberships")
  .add(
    HttpApiEndpoint.get("list")`/organizations/${organizationIdParam}/memberships`
      .addSuccess(Schema.Array(OrganizationMembershipSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("create")`/organizations/${organizationIdParam}/memberships`
      .setPayload(CreateMembershipPayloadSchema)
      .addSuccess(OrganizationMembershipSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.patch("update")`/organizations/${organizationIdParam}/memberships/${accountIdParam}`
      .setPayload(UpdateMembershipPayloadSchema)
      .addSuccess(OrganizationMembershipSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/organizations/${organizationIdParam}/memberships/${accountIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
