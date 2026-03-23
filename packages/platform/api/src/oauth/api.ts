import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  JsonObjectSchema,
  SecretRefSchema,
  SourceAuthSessionIdSchema,
  ScopeIdSchema as WorkspaceIdSchema,
} from "@executor/platform-sdk/schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "@executor/platform-sdk/errors";
import { TrimmedNonEmptyStringSchema } from "@executor/platform-sdk/string-schemas";

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);

const HtmlSchema = HttpApiSchema.Text({
  contentType: "text/html",
});

export const StartSourceOAuthPayloadSchema = Schema.Struct({
  providerKey: TrimmedNonEmptyStringSchema,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  config: Schema.optional(Schema.NullOr(JsonObjectSchema)),
});

export type StartSourceOAuthPayload = typeof StartSourceOAuthPayloadSchema.Type;

export const StartSourceOAuthResultSchema = Schema.Struct({
  sessionId: SourceAuthSessionIdSchema,
  authorizationUrl: Schema.String,
});

export type StartSourceOAuthResult = typeof StartSourceOAuthResultSchema.Type;

export const SourceOAuthAuthSchema = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  headerName: Schema.String,
  prefix: Schema.String,
  accessToken: SecretRefSchema,
  refreshToken: Schema.NullOr(SecretRefSchema),
});

export const CompleteSourceOAuthResultSchema = Schema.Struct({
  sessionId: SourceAuthSessionIdSchema,
  auth: SourceOAuthAuthSchema,
});

export type CompleteSourceOAuthResult = typeof CompleteSourceOAuthResultSchema.Type;

export const SourceOAuthPopupSuccessResultSchema = Schema.Struct({
  type: Schema.Literal("executor:oauth-result"),
  ok: Schema.Literal(true),
  sessionId: SourceAuthSessionIdSchema,
  auth: SourceOAuthAuthSchema,
});

export const SourceOAuthPopupFailureResultSchema = Schema.Struct({
  type: Schema.Literal("executor:oauth-result"),
  ok: Schema.Literal(false),
  sessionId: Schema.Null,
  error: Schema.String,
});

export const SourceOAuthPopupResultSchema = Schema.Union(
  SourceOAuthPopupSuccessResultSchema,
  SourceOAuthPopupFailureResultSchema,
);

export type SourceOAuthPopupResult = typeof SourceOAuthPopupResultSchema.Type;

const OAuthCallbackUrlParamsSchema = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

export class OAuthApi extends HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.post("startSourceAuth")`/workspaces/${workspaceIdParam}/oauth/source-auth/start`
      .setPayload(StartSourceOAuthPayloadSchema)
      .addSuccess(StartSourceOAuthResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("sourceAuthCallback")`/oauth/source-auth/callback`
      .setUrlParams(OAuthCallbackUrlParamsSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
