import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId, SecretBackedValue } from "@executor-js/sdk/core";
import { InternalError } from "@executor-js/api";

import { GoogleDiscoveryParseError, GoogleDiscoverySourceError } from "../sdk/errors";
import { GoogleDiscoveryStoredSourceSchema } from "../sdk/stored-source";

export { HttpApiSchema };

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);

const DiscoveryCredentialsPayload = Schema.Struct({
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: SecretBackedValue })),
  queryParams: Schema.optional(Schema.Record({ key: Schema.String, value: SecretBackedValue })),
});

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
  credentials: Schema.optional(DiscoveryCredentialsPayload),
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
  credentials: Schema.optional(DiscoveryCredentialsPayload),
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

// OAuth start/complete/callback payloads/responses live on the shared
// `/scopes/:scopeId/oauth/*` group in `@executor-js/api` now — no
// plugin-specific OAuth schemas needed here.

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
    HttpApiEndpoint.get(
      "getSource",
    )`/scopes/${scopeIdParam}/google-discovery/sources/${namespaceParam}`.addSuccess(
      Schema.NullOr(GoogleDiscoveryStoredSourceSchema),
    ),
  )
  // Errors declared once at the group level — every endpoint inherits.
  // `InternalError` is the shared opaque 500 translated at the HTTP edge
  // by `withCapture`. The others are 4xx domain errors carrying their
  // status via `HttpApiSchema.annotations`.
  .addError(InternalError)
  .addError(GoogleDiscoveryApiError)
  .addError(GoogleDiscoveryParseError)
  .addError(GoogleDiscoverySourceError) {}
