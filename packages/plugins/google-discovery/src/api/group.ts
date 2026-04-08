import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";

export { HttpApiSchema };

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);

const AuthPayload = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    clientId: Schema.String,
    clientSecretSecretId: Schema.NullOr(Schema.String),
    accessTokenSecretId: Schema.String,
    refreshTokenSecretId: Schema.NullOr(Schema.String),
    tokenType: Schema.optional(Schema.String),
    expiresAt: Schema.NullOr(Schema.Number),
    scope: Schema.NullOr(Schema.String),
    scopes: Schema.Array(Schema.String),
  }),
);

const ProbePayload = Schema.Struct({
  discoveryUrl: Schema.String,
});

const ProbeResponse = Schema.Struct({
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  service: Schema.String,
  version: Schema.String,
  toolCount: Schema.Number,
  scopes: Schema.Array(Schema.String),
});

const AddSourcePayload = Schema.Struct({
  name: Schema.String,
  discoveryUrl: Schema.String,
  namespace: Schema.optional(Schema.String),
  auth: AuthPayload,
});

const AddSourceResponse = Schema.Struct({
  toolCount: Schema.Number,
  namespace: Schema.String,
});

const StartOAuthPayload = Schema.Struct({
  name: Schema.String,
  discoveryUrl: Schema.String,
  clientId: Schema.String,
  clientSecretSecretId: Schema.optional(Schema.NullOr(Schema.String)),
  redirectUrl: Schema.String,
  scopes: Schema.optional(Schema.Array(Schema.String)),
});

const StartOAuthResponse = Schema.Struct({
  sessionId: Schema.String,
  authorizationUrl: Schema.String,
  scopes: Schema.Array(Schema.String),
});

const CompleteOAuthPayload = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

const CompleteOAuthResponse = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  clientId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});

const OAuthCallbackParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const HtmlResponse = HttpApiSchema.Text({ contentType: "text/html" });

const ApiError = Schema.Struct({
  message: Schema.String,
}).annotations(HttpApiSchema.annotations({ status: 400 }));

export class GoogleDiscoveryGroup extends HttpApiGroup.make("googleDiscovery")
  .add(
    HttpApiEndpoint.post("probeDiscovery")`/scopes/${scopeIdParam}/google-discovery/probe`
      .setPayload(ProbePayload)
      .addSuccess(ProbeResponse)
      .addError(ApiError),
  )
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/google-discovery/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse)
      .addError(ApiError),
  )
  .add(
    HttpApiEndpoint.post("startOAuth")`/scopes/${scopeIdParam}/google-discovery/oauth/start`
      .setPayload(StartOAuthPayload)
      .addSuccess(StartOAuthResponse)
      .addError(ApiError),
  )
  .add(
    HttpApiEndpoint.post("completeOAuth")`/scopes/${scopeIdParam}/google-discovery/oauth/complete`
      .setPayload(CompleteOAuthPayload)
      .addSuccess(CompleteOAuthResponse)
      .addError(ApiError),
  )
  .add(
    HttpApiEndpoint.get("oauthCallback")`/google-discovery/oauth/callback`
      .setUrlParams(OAuthCallbackParams)
      .addSuccess(HtmlResponse)
      .addError(ApiError),
  )
  {}
