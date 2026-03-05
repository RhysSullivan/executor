import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  OrganizationIdSchema,
  WorkspaceIdSchema,
  WorkspaceInsertSchema,
  WorkspaceSchema,
  WorkspaceUpdateSchema,
} from "#schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

export const CreateWorkspacePayloadSchema = WorkspaceInsertSchema.pipe(
  Schema.pick("name"),
);

export type CreateWorkspacePayload = typeof CreateWorkspacePayloadSchema.Type;

export const UpdateWorkspacePayloadSchema = WorkspaceUpdateSchema.pipe(
  Schema.pick("name"),
  Schema.partialWith({ exact: true }),
);

export type UpdateWorkspacePayload = typeof UpdateWorkspacePayloadSchema.Type;

const organizationIdParam = HttpApiSchema.param("organizationId", OrganizationIdSchema);
const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);

export class WorkspacesApi extends HttpApiGroup.make("workspaces")
  .add(
    HttpApiEndpoint.get("list")`/organizations/${organizationIdParam}/workspaces`
      .addSuccess(Schema.Array(WorkspaceSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("create")`/organizations/${organizationIdParam}/workspaces`
      .setPayload(CreateWorkspacePayloadSchema)
      .addSuccess(WorkspaceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/workspaces/${workspaceIdParam}`
      .addSuccess(WorkspaceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.patch("update")`/workspaces/${workspaceIdParam}`
      .setPayload(UpdateWorkspacePayloadSchema)
      .addSuccess(WorkspaceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/workspaces/${workspaceIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
