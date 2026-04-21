import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";
import { InternalError } from "@executor/api";

import {
  GoogleDiscoveryOAuthError,
  GoogleDiscoveryParseError,
  GoogleDiscoverySourceError,
} from "../sdk/errors";
import { GoogleDiscoveryStoredSourceSchema } from "../sdk/stored-source";

export { HttpApiSchema };

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);

const AuthPayload = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    connectionId: Schema.String,
    clientIdSecretId: Schema.String,
    clientSecretSecretId: Schema.NullOr(Schema.String),
    scopes: Schema.Array(Schema.String),
  }),
);

const ProbePayload = Schema.Struct({
  discoveryUrl: Schema.String,
});

const ProbeOperation = Schema.Struct({
  toolPath: Schema.String,
  method: Schema.String,
  pathTemplate: Schema.String,
  description: Schema.NullOr(Schema.String),
});

const ProbeResponse = Schema.Struct({
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  service: Schema.String,
  version: Schema.String,
  toolCount: Schema.Number,
  scopes: Schema.Array(Schema.String),
  operations: Schema.Array(ProbeOperation),
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

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  auth: Schema.optional(AuthPayload),
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
});

const StartOAuthPayload = Schema.Struct({
  name: Schema.String,
  discoveryUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.optional(Schema.NullOr(Schema.String)),
  redirectUrl: Schema.String,
  scopes: Schema.optional(Schema.Array(Schema.String)),
  /** Optional executor scope that will own the resulting Connection. */
  tokenScope: Schema.optional(Schema.String),
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
  /** Id of the Connection the SDK minted. The caller stores it on the
   *  source's `oauth2` field and resolves tokens via `ctx.connections`. */
  connectionId: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});

const OAuthCallbackParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const HtmlResponse = HttpApiSchema.Text({ contentType: "text/html" });

export class GoogleDiscoveryApiError extends Schema.TaggedError<GoogleDiscoveryApiError>()(
  "GoogleDiscoveryApiError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

// ---------------------------------------------------------------------------
// Group
//
// Domain errors + the shared opaque 500 (`InternalError`) are declared
// once at the group level via `.addError(...)` — every endpoint
// inherits them. The domain error carries its HTTP status via
// `HttpApiSchema.annotations`; `InternalError` is the public 5xx
// surface, translated from `StorageError` at the HTTP edge by
// `withCapture`. No per-endpoint `.addError(...)`, no per-handler
// InternalError — handlers just `return yield* ext.foo(...)`.
// ---------------------------------------------------------------------------

export class GoogleDiscoveryGroup extends HttpApiGroup.make("googleDiscovery")
  .add(
    HttpApiEndpoint.post("probeDiscovery")`/scopes/${scopeIdParam}/google-discovery/probe`
      .setPayload(ProbePayload)
      .addSuccess(ProbeResponse),
  )
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/google-discovery/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse),
  )
  .add(
    HttpApiEndpoint.patch(
      "updateSource",
    )`/scopes/${scopeIdParam}/google-discovery/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  )
  .add(
    HttpApiEndpoint.post("startOAuth")`/scopes/${scopeIdParam}/google-discovery/oauth/start`
      .setPayload(StartOAuthPayload)
      .addSuccess(StartOAuthResponse),
  )
  .add(
    HttpApiEndpoint.post("completeOAuth")`/scopes/${scopeIdParam}/google-discovery/oauth/complete`
      .setPayload(CompleteOAuthPayload)
      .addSuccess(CompleteOAuthResponse),
  )
  .add(
    HttpApiEndpoint.get("oauthCallback")`/google-discovery/oauth/callback`
      .setUrlParams(OAuthCallbackParams)
      .addSuccess(HtmlResponse),
  )
  .add(
    HttpApiEndpoint.get(
      "getSource",
    )`/scopes/${scopeIdParam}/google-discovery/sources/${namespaceParam}`
      .addSuccess(Schema.NullOr(GoogleDiscoveryStoredSourceSchema)),
  )
  // Errors declared once at the group level — every endpoint inherits.
  // `InternalError` is the shared opaque 500 translated at the HTTP edge
  // by `withCapture`. The others are 4xx domain errors carrying their
  // status via `HttpApiSchema.annotations`; handlers return them through
  // the typed channel and HttpApi encodes them directly. We only list
  // errors a Google Discovery *group* endpoint can surface —
  // `GoogleDiscoveryInvocationError` is thrown inside `invokeTool` which
  // is reached via the core `tools.invoke` endpoint, not any Google
  // Discovery-group endpoint, so it doesn't belong here.
  .addError(InternalError)
  .addError(GoogleDiscoveryApiError)
  .addError(GoogleDiscoveryOAuthError)
  .addError(GoogleDiscoveryParseError)
  .addError(GoogleDiscoverySourceError) {}
