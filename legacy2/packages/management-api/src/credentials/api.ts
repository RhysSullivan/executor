import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  SourceAuthBindingIdSchema,
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
  Schema.pick("credentialId", "scopeType", "sourceKey", "provider"),
);

const OptionalUpsertCredentialBindingPayloadSchema = SourceCredentialBindingSchema.pipe(
  Schema.pick(
    "id",
    "accountId",
    "additionalHeadersJson",
    "boundAuthFingerprint",
  ),
  Schema.partialWith({ exact: true }),
);

const UpsertCredentialSecretPayloadSchema = Schema.Struct({
  secret: Schema.String,
});

const OptionalOAuthUpsertFieldsSchema = Schema.Struct({
  oauthRefreshToken: Schema.NullOr(Schema.String),
  oauthExpiresAt: Schema.NullOr(Schema.Number),
  oauthScope: Schema.NullOr(Schema.String),
  oauthIssuer: Schema.NullOr(Schema.String),
  oauthTokenEndpoint: Schema.NullOr(Schema.String),
  oauthAuthorizationServer: Schema.NullOr(Schema.String),
  oauthClientId: Schema.NullOr(Schema.String),
  oauthClientSecret: Schema.NullOr(Schema.String),
  oauthSourceUrl: Schema.NullOr(Schema.String),
  oauthClientInformationJson: Schema.NullOr(Schema.String),
}).pipe(Schema.partialWith({ exact: true }));

export const UpsertCredentialBindingPayloadSchema =
  RequiredUpsertCredentialBindingPayloadSchema.pipe(
    Schema.extend(UpsertCredentialSecretPayloadSchema),
    Schema.extend(OptionalUpsertCredentialBindingPayloadSchema),
    Schema.extend(OptionalOAuthUpsertFieldsSchema),
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
  SourceAuthBindingIdSchema,
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
