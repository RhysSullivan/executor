import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { OrganizationSchema } from "@executor-v2/schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

const RequiredUpsertOrganizationPayloadSchema = OrganizationSchema.pipe(
  Schema.pick("slug", "name"),
);

const OptionalUpsertOrganizationPayloadSchema = OrganizationSchema.pipe(
  Schema.pick("id", "status", "createdByAccountId"),
  Schema.partialWith({ exact: true }),
);

export const UpsertOrganizationPayloadSchema =
  RequiredUpsertOrganizationPayloadSchema.pipe(
    Schema.extend(OptionalUpsertOrganizationPayloadSchema),
  );

export type UpsertOrganizationPayload =
  typeof UpsertOrganizationPayloadSchema.Type;

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
    HttpApiEndpoint.post("upsert")`/organizations`
      .setPayload(UpsertOrganizationPayloadSchema)
      .addSuccess(OrganizationSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
