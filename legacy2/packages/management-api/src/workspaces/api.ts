import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { WorkspaceSchema } from "@executor-v2/schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

const RequiredUpsertWorkspacePayloadSchema = WorkspaceSchema.pipe(
  Schema.pick("name", "organizationId"),
);

const OptionalUpsertWorkspacePayloadSchema = WorkspaceSchema.pipe(
  Schema.pick("id"),
  Schema.partialWith({ exact: true }),
);

export const UpsertWorkspacePayloadSchema = RequiredUpsertWorkspacePayloadSchema.pipe(
  Schema.extend(OptionalUpsertWorkspacePayloadSchema),
);

export type UpsertWorkspacePayload = typeof UpsertWorkspacePayloadSchema.Type;

export class WorkspacesApi extends HttpApiGroup.make("workspaces")
  .add(
    HttpApiEndpoint.get("list")`/workspaces`
      .addSuccess(Schema.Array(WorkspaceSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("upsert")`/workspaces`
      .setPayload(UpsertWorkspacePayloadSchema)
      .addSuccess(WorkspaceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
