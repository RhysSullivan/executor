import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  CredentialBindingIdSchema,
  SourceCredentialBindingSchema,
  WorkspaceIdSchema,
} from "@executor-v2/schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

const RequiredUpsertCredentialBindingPayloadSchema = SourceCredentialBindingSchema.pipe(
  Schema.pick("credentialId", "scopeType", "sourceKey", "provider", "secretRef"),
);

const OptionalUpsertCredentialBindingPayloadSchema = SourceCredentialBindingSchema.pipe(
  Schema.pick(
    "id",
    "accountId",
    "secretProvider",
    "additionalHeadersJson",
    "boundAuthFingerprint",
  ),
  Schema.partialWith({ exact: true }),
);

export const UpsertCredentialBindingPayloadSchema =
  RequiredUpsertCredentialBindingPayloadSchema.pipe(
    Schema.extend(OptionalUpsertCredentialBindingPayloadSchema),
  );

export type UpsertCredentialBindingPayload =
  typeof UpsertCredentialBindingPayloadSchema.Type;

export const RemoveCredentialBindingResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type RemoveCredentialBindingResult =
  typeof RemoveCredentialBindingResultSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const credentialBindingIdParam = HttpApiSchema.param(
  "credentialBindingId",
  CredentialBindingIdSchema,
);

export class CredentialsApi extends HttpApiGroup.make("credentials")
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/credentials`
      .addSuccess(Schema.Array(SourceCredentialBindingSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("upsert")`/workspaces/${workspaceIdParam}/credentials`
      .setPayload(UpsertCredentialBindingPayloadSchema)
      .addSuccess(SourceCredentialBindingSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del(
      "remove",
    )`/workspaces/${workspaceIdParam}/credentials/${credentialBindingIdParam}`
      .addSuccess(RemoveCredentialBindingResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
