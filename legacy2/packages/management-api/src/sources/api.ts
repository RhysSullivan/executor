import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { SourceIdSchema, SourceSchema, WorkspaceIdSchema } from "@executor-v2/schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

const RequiredUpsertSourcePayloadSchema = SourceSchema.pipe(
  Schema.pick("name", "kind", "endpoint"),
);

const OptionalUpsertSourcePayloadSchema = SourceSchema.pipe(
  Schema.pick("id", "status", "enabled", "configJson", "sourceHash", "lastError"),
  Schema.partialWith({ exact: true }),
);

export const UpsertSourcePayloadSchema = RequiredUpsertSourcePayloadSchema.pipe(
  Schema.extend(OptionalUpsertSourcePayloadSchema),
);

export type UpsertSourcePayload = typeof UpsertSourcePayloadSchema.Type;

export const RemoveSourceResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type RemoveSourceResult = typeof RemoveSourceResultSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const sourceIdParam = HttpApiSchema.param("sourceId", SourceIdSchema);

export class SourcesApi extends HttpApiGroup.make("sources")
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/sources`
      .addSuccess(Schema.Array(SourceSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("upsert")`/workspaces/${workspaceIdParam}/sources`
      .setPayload(UpsertSourcePayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}`
      .addSuccess(RemoveSourceResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
