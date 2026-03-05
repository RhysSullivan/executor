import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  InteractionActionSchema,
  InteractionIdSchema,
  InteractionSchema,
  TaskRunIdSchema,
  WorkspaceIdSchema,
} from "@executor-v2/schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

export const ResolveInteractionPayloadSchema = Schema.Struct({
  action: InteractionActionSchema,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  contentJson: Schema.optional(Schema.NullOr(Schema.String)),
});

export type ResolveInteractionPayload = typeof ResolveInteractionPayloadSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const runIdParam = HttpApiSchema.param("runId", TaskRunIdSchema);
const interactionIdParam = HttpApiSchema.param("interactionId", InteractionIdSchema);

export class InteractionsApi extends HttpApiGroup.make("interactions")
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/interactions`
      .addSuccess(Schema.Array(InteractionSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("list-run")`/workspaces/${workspaceIdParam}/runs/${runIdParam}/interactions`
      .addSuccess(Schema.Array(InteractionSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/workspaces/${workspaceIdParam}/interactions/${interactionIdParam}`
      .addSuccess(InteractionSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post(
      "resolve",
    )`/workspaces/${workspaceIdParam}/interactions/${interactionIdParam}/resolve`
      .setPayload(ResolveInteractionPayloadSchema)
      .addSuccess(InteractionSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
