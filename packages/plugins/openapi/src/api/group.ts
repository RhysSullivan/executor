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
import { OAuth2Auth } from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddSpecPayload = Schema.Struct({
  spec: Schema.String,
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  oauth2: Schema.optional(OAuth2Auth),
});

const PreviewSpecPayload = Schema.Struct({
  spec: Schema.String,
});

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
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

const StartOAuthPayload = Schema.Struct({
  displayName: Schema.String,
  securitySchemeName: Schema.String,
  flow: Schema.Literal("authorizationCode"),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  redirectUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: Schema.Array(Schema.String),
  // Caller-owned token identity. `tokenScope` names which executor scope
  // will own the minted tokens (typically the per-user scope). The two
  // token secret ids are pre-decided so the source's stored `OAuth2Auth`
  // can reference the same ids across every user — per-user values
  // shadow org-level fallbacks via secret fall-through on read.
  tokenScope: Schema.optional(ScopeId),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.optional(Schema.NullOr(Schema.String)),
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

const OAuthCallbackUrlParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Errors with HTTP status
// ---------------------------------------------------------------------------

const ParseError = OpenApiParseError.annotations(HttpApiSchema.annotations({ status: 400 }));
const ExtractionError = OpenApiExtractionError.annotations(
  HttpApiSchema.annotations({ status: 400 }),
);
const OAuthError = OpenApiOAuthError.annotations(HttpApiSchema.annotations({ status: 400 }));

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
  .addError(ParseError)
  .addError(ExtractionError)
  .addError(OAuthError) {}
