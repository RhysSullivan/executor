import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError } from "@executor-js/api";

import { ScopeId } from "@executor-js/sdk";
import { SecretBackedValue } from "@executor-js/sdk";
import { GoogleDiscoveryParseError, GoogleDiscoverySourceError } from "../sdk/errors";
import { GoogleDiscoveryStoredSourceSchema } from "../sdk/stored-source";

export { HttpApiSchema };

const DiscoveryCredentialsPayload = Schema.Struct({
  headers: Schema.optional(Schema.Record(Schema.String, SecretBackedValue)),
  queryParams: Schema.optional(Schema.Record(Schema.String, SecretBackedValue)),
});

const AuthPayload = Schema.Union([
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
]);

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

export class GoogleDiscoveryApiError extends Schema.TaggedErrorClass<GoogleDiscoveryApiError>()(
  "GoogleDiscoveryApiError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

const GoogleDiscoveryErrors = [
  InternalError,
  GoogleDiscoveryApiError,
  GoogleDiscoveryParseError,
  GoogleDiscoverySourceError,
] as const;

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

export const GoogleDiscoveryGroup = HttpApiGroup.make("googleDiscovery")
  .add(
    HttpApiEndpoint.post("probeDiscovery", "/scopes/:scopeId/google-discovery/probe", {
      params: { scopeId: ScopeId },
      payload: ProbePayload,
      success: ProbeResponse,
      error: GoogleDiscoveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("addSource", "/scopes/:scopeId/google-discovery/sources", {
      params: { scopeId: ScopeId },
      payload: AddSourcePayload,
      success: AddSourceResponse,
      error: GoogleDiscoveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateSource", "/scopes/:scopeId/google-discovery/sources/:namespace", {
      params: { scopeId: ScopeId, namespace: Schema.String },
      payload: UpdateSourcePayload,
      success: UpdateSourceResponse,
      error: GoogleDiscoveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getSource", "/scopes/:scopeId/google-discovery/sources/:namespace", {
      params: { scopeId: ScopeId, namespace: Schema.String },
      success: Schema.NullOr(GoogleDiscoveryStoredSourceSchema),
      error: GoogleDiscoveryErrors,
    }),
  );
// Errors are declared per endpoint in Effect v4.
