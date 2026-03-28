import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import * as Schema from "effect/Schema";
import {
  CreateExecutionPayloadSchema,
  ResumeExecutionPayloadSchema,
} from "@executor/platform-sdk/contracts";
export type {
  CreateExecutionPayload,
  ResumeExecutionPayload,
} from "@executor/platform-sdk/contracts";
import {
  ExecutionSchema,
  ExecutionIdSchema,
  ExecutionEnvelopeSchema,
  ScopeIdSchema as WorkspaceIdSchema,
} from "@executor/platform-sdk/schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "@executor/platform-sdk/errors";

export {
  CreateExecutionPayloadSchema,
  ResumeExecutionPayloadSchema,
};

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const executionIdParam = HttpApiSchema.param("executionId", ExecutionIdSchema);

export class ExecutionsApi extends HttpApiGroup.make("executions")
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/executions`
      .addSuccess(Schema.Array(ExecutionSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("create")`/workspaces/${workspaceIdParam}/executions`
      .setPayload(CreateExecutionPayloadSchema)
      .addSuccess(ExecutionEnvelopeSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/workspaces/${workspaceIdParam}/executions/${executionIdParam}`
      .addSuccess(ExecutionEnvelopeSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("resume")`/workspaces/${workspaceIdParam}/executions/${executionIdParam}/resume`
      .setPayload(ResumeExecutionPayloadSchema)
      .addSuccess(ExecutionEnvelopeSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
