import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  OrganizationIdSchema,
  OrganizationInsertSchema,
  OrganizationSchema,
  OrganizationUpdateSchema,
} from "#schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

const createOrganizationPayloadRequiredSchema = OrganizationInsertSchema.pipe(
  Schema.pick("name"),
);

const createOrganizationPayloadOptionalSchema = OrganizationInsertSchema.pipe(
  Schema.pick("slug"),
  Schema.partialWith({ exact: true }),
);

export const CreateOrganizationPayloadSchema = Schema.extend(
  createOrganizationPayloadRequiredSchema,
  createOrganizationPayloadOptionalSchema,
);

export type CreateOrganizationPayload = typeof CreateOrganizationPayloadSchema.Type;

export const UpdateOrganizationPayloadSchema = OrganizationUpdateSchema.pipe(
  Schema.pick("name", "status"),
  Schema.partialWith({ exact: true }),
);

export type UpdateOrganizationPayload = typeof UpdateOrganizationPayloadSchema.Type;

const organizationIdParam = HttpApiSchema.param("organizationId", OrganizationIdSchema);

export class OrganizationsApi extends HttpApiGroup.make("organizations")
  .add(
    HttpApiEndpoint.get("list")`/organizations`
      .addSuccess(Schema.Array(OrganizationSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("create")`/organizations`
      .setPayload(CreateOrganizationPayloadSchema)
      .addSuccess(OrganizationSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/organizations/${organizationIdParam}`
      .addSuccess(OrganizationSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.patch("update")`/organizations/${organizationIdParam}`
      .setPayload(UpdateOrganizationPayloadSchema)
      .addSuccess(OrganizationSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/organizations/${organizationIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
