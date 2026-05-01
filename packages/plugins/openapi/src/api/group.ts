import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId, SecretBackedValue } from "@executor-js/sdk/core";
import { InternalError } from "@executor-js/api";

import { OpenApiParseError, OpenApiExtractionError, OpenApiOAuthError } from "../sdk/errors";
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

const SpecFetchCredentialsPayload = Schema.Struct({
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: SecretBackedValue })),
  queryParams: Schema.optional(Schema.Record({ key: Schema.String, value: SecretBackedValue })),
});

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddSpecPayload = Schema.Struct({
  spec: Schema.String,
  specFetchCredentials: Schema.optional(SpecFetchCredentialsPayload),
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  queryParams: Schema.optional(Schema.Record({ key: Schema.String, value: SecretBackedValue })),
  oauth2: Schema.optional(Schema.Union(OAuth2Auth, OAuth2SourceConfig)),
});

const PreviewSpecPayload = Schema.Struct({
  spec: Schema.String,
  specFetchCredentials: Schema.optional(SpecFetchCredentialsPayload),
});

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  queryParams: Schema.optional(Schema.Record({ key: Schema.String, value: SecretBackedValue })),
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
    HttpApiEndpoint.get(
      "getSource",
    )`/scopes/${scopeIdParam}/openapi/sources/${namespaceParam}`.addSuccess(
      Schema.NullOr(StoredSourceSchema),
    ),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/openapi/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  )
  .add(
    HttpApiEndpoint.get(
      "listSourceBindings",
    )`/scopes/${scopeIdParam}/openapi/sources/${namespaceParam}/base/${sourceScopeIdParam}/bindings`.addSuccess(
      Schema.Array(OpenApiSourceBindingRef),
    ),
  )
  .add(
    HttpApiEndpoint.post("setSourceBinding")`/scopes/${scopeIdParam}/openapi/source-bindings`
      .setPayload(OpenApiSourceBindingInput)
      .addSuccess(OpenApiSourceBindingRef),
  )
  .add(
    HttpApiEndpoint.post(
      "removeSourceBinding",
    )`/scopes/${scopeIdParam}/openapi/source-bindings/remove`
      .setPayload(RemoveBindingPayload)
      .addSuccess(Schema.Struct({ removed: Schema.Boolean })),
  )
  // Errors declared once at the group level — every endpoint inherits.
  // Plugin domain errors carry their own HttpApiSchema status (4xx);
  // `InternalError` is the shared opaque 500 translated at the HTTP
  // edge by `withCapture`.
  .addError(InternalError)
  .addError(OpenApiParseError)
  .addError(OpenApiExtractionError)
  .addError(OpenApiOAuthError) {}
