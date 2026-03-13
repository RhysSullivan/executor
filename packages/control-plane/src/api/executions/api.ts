import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  ExecutionIdSchema,
  ExecutionEnvelopeSchema,
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
import { TrimmedNonEmptyStringSchema } from "../string-schemas";

export const CreateExecutionPayloadSchema = Schema.Struct({
  code: TrimmedNonEmptyStringSchema,
  interactionMode: Schema.optional(Schema.Literal("live", "live_form", "detach")),
});

export type CreateExecutionPayload = typeof CreateExecutionPayloadSchema.Type;

export const ResumeExecutionPayloadSchema = Schema.Struct({
  responseJson: Schema.optional(Schema.String),
  interactionMode: Schema.optional(Schema.Literal("live", "live_form", "detach")),
});

export type ResumeExecutionPayload = typeof ResumeExecutionPayloadSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const executionIdParam = HttpApiSchema.param("executionId", ExecutionIdSchema);

export class ExecutionsApi extends HttpApiGroup.make("executions")
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
