import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";
import { InternalError } from "@executor/api";

import {
  OpenApiParseError,
  OpenApiExtractionError,
  OpenApiOAuthError,
} from "../sdk/errors";
import { SpecPreview } from "../sdk/preview";
import { StoredSourceSchema } from "../sdk/store";
import {
  OAuth2Auth,
  OAuth2SourceConfig,
  OpenApiSourceBindingInput,
  OpenApiSourceBindingRef,
} from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);
const sourceScopeIdParam = HttpApiSchema.param("sourceScopeId", ScopeId);

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddSpecPayload = Schema.Struct({
  spec: Schema.String,
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  oauth2: Schema.optional(Schema.Union(OAuth2Auth, OAuth2SourceConfig)),
});

const PreviewSpecPayload = Schema.Struct({
  spec: Schema.String,
});

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  // Set after a successful re-authenticate to refresh the source's
  // stored OAuth2 metadata.
  oauth2: Schema.optional(Schema.Union(OAuth2Auth, OAuth2SourceConfig)),
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
});

const RemoveBindingPayload = Schema.Struct({
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slot: Schema.String,
  scope: ScopeId,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddSpecResponse = Schema.Struct({
  toolCount: Schema.Number,
  namespace: Schema.String,
});

// ---------------------------------------------------------------------------
// OAuth payloads / responses
// ---------------------------------------------------------------------------

// Shared identity fields for both OAuth2 flows.
//
// `sourceId` (namespace) pins the resulting Connection *name* to a
// stable per-source value so repeated sign-ins refresh an existing
// row per scope instead of spawning a fresh UUID every click. Both
// flows write at the innermost executor scope by default (per-user
// row, per-user token), which preserves per-user credentials via
// scope-stacked secret shadowing.
//
// `tokenScope` defaults to `ctx.scopes[0].id` (innermost). Callers
// can override — e.g. an admin writing an org-wide shared connection
// — and the SDK validates that the target is in the executor's stack.
const StartOAuthIdentityFields = {
  displayName: Schema.String,
  securitySchemeName: Schema.String,
  tokenUrl: Schema.String,
  clientIdSecretId: Schema.String,
  scopes: Schema.Array(Schema.String),
  tokenScope: Schema.optional(ScopeId),
  connectionId: Schema.optional(Schema.String),
  sourceId: Schema.String,
} as const;

const StartOAuthPayload = Schema.Union(
  Schema.Struct({
    ...StartOAuthIdentityFields,
    flow: Schema.Literal("authorizationCode"),
    authorizationUrl: Schema.String,
    redirectUrl: Schema.String,
    clientSecretSecretId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  // RFC 6749 §4.4 — no user-interactive step, no session, no popup. The
  // plugin exchanges tokens inline and returns a completed auth. The
  // client_secret is required (the grant is client authentication + token
  // request) and no refresh token is issued (§4.4.3).
  Schema.Struct({
    ...StartOAuthIdentityFields,
    flow: Schema.Literal("clientCredentials"),
    clientSecretSecretId: Schema.String,
  }),
);

const StartOAuthResponse = Schema.Union(
  Schema.Struct({
    flow: Schema.Literal("authorizationCode"),
    sessionId: Schema.String,
    authorizationUrl: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    flow: Schema.Literal("clientCredentials"),
    auth: OAuth2Auth,
    scopes: Schema.Array(Schema.String),
  }),
);

const CompleteOAuthPayload = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

const OAuthCallbackUrlParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

// HTTP status on the three domain errors lives on their class
// declarations in `../sdk/errors.ts` — see the comment there.

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (OpenApiParseError, OpenApiExtractionError,
// OpenApiOAuthError) are declared once at the group level via
// `.addError(...)` — every endpoint inherits them. The errors themselves
// carry their HTTP status via `HttpApiSchema.annotations` above, so
// handlers just `return yield* ext.foo(...)` and the schema encodes
// whatever comes out.
//
// 5xx is handled at the API level: `.addError(InternalError)` adds the
// shared opaque 500 surface. Defects are captured + downgraded to it by
// an HttpApiBuilder middleware (see apps/cloud/src/observability.ts).
// StorageError → InternalError translation happens at service wiring
// time via `withCapture(executor)`.
// ---------------------------------------------------------------------------

export class OpenApiGroup extends HttpApiGroup.make("openapi")
  .add(
    HttpApiEndpoint.post("previewSpec")`/scopes/${scopeIdParam}/openapi/preview`
      .setPayload(PreviewSpecPayload)
      .addSuccess(SpecPreview),
  )
  .add(
    HttpApiEndpoint.post("addSpec")`/scopes/${scopeIdParam}/openapi/specs`
      .setPayload(AddSpecPayload)
      .addSuccess(AddSpecResponse),
  )
  .add(
    HttpApiEndpoint.get("getSource")`/scopes/${scopeIdParam}/openapi/sources/${namespaceParam}`
      .addSuccess(Schema.NullOr(StoredSourceSchema)),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/openapi/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  )
  .add(
    HttpApiEndpoint.get(
      "listSourceBindings",
    )`/scopes/${scopeIdParam}/openapi/sources/${namespaceParam}/base/${sourceScopeIdParam}/bindings`
      .addSuccess(Schema.Array(OpenApiSourceBindingRef)),
  )
  .add(
    HttpApiEndpoint.post("setSourceBinding")`/scopes/${scopeIdParam}/openapi/source-bindings`
      .setPayload(OpenApiSourceBindingInput)
      .addSuccess(OpenApiSourceBindingRef),
  )
  .add(
    HttpApiEndpoint.post("removeSourceBinding")`/scopes/${scopeIdParam}/openapi/source-bindings/remove`
      .setPayload(RemoveBindingPayload)
      .addSuccess(Schema.Struct({ removed: Schema.Boolean })),
  )
  .add(
    HttpApiEndpoint.post("startOAuth")`/scopes/${scopeIdParam}/openapi/oauth/start`
      .setPayload(StartOAuthPayload)
      .addSuccess(StartOAuthResponse),
  )
  .add(
    HttpApiEndpoint.post("completeOAuth")`/scopes/${scopeIdParam}/openapi/oauth/complete`
      .setPayload(CompleteOAuthPayload)
      .addSuccess(OAuth2Auth),
  )
  .add(
    HttpApiEndpoint.get("oauthCallback", "/openapi/oauth/callback")
      .setUrlParams(OAuthCallbackUrlParams)
      .addSuccess(
        Schema.Unknown.annotations(
          HttpApiSchema.annotations({ contentType: "text/html" }),
        ),
      ),
  )
  // Errors declared once at the group level — every endpoint inherits.
  // Plugin domain errors carry their own HttpApiSchema status (4xx);
  // `InternalError` is the shared opaque 500 translated at the HTTP
  // edge by `withCapture`.
  .addError(InternalError)
  .addError(OpenApiParseError)
  .addError(OpenApiExtractionError)
  .addError(OpenApiOAuthError) {}
