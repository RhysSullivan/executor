import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId, SecretBackedMap } from "@executor-js/sdk/core";
import { InternalError } from "@executor-js/api";

import { McpConnectionError, McpToolDiscoveryError } from "../sdk/errors";
import { McpStoredSourceSchema } from "../sdk/stored-source";

// Re-export for handler use
export { HttpApiSchema };

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);

// ---------------------------------------------------------------------------
// Auth payload (only for remote)
// ---------------------------------------------------------------------------

const AuthPayload = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("header"),
    headerName: Schema.String,
    secretId: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    /** Stable id of the SDK Connection minted by `completeOAuth`. The
     *  backing access/refresh secrets live on the connection row; the
     *  source only needs this pointer. */
    connectionId: Schema.String,
    clientIdSecretId: Schema.optional(Schema.String),
    clientSecretSecretId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const StringMap = Schema.Record({ key: Schema.String, value: Schema.String });
// ---------------------------------------------------------------------------
// Add source — discriminated union on transport
// ---------------------------------------------------------------------------

const AddRemoteSourcePayload = Schema.Struct({
  transport: Schema.Literal("remote"),
  name: Schema.String,
  endpoint: Schema.String,
  remoteTransport: Schema.optional(Schema.Literal("streamable-http", "sse", "auto")),
  namespace: Schema.optional(Schema.String),
  queryParams: Schema.optional(SecretBackedMap),
  headers: Schema.optional(SecretBackedMap),
  auth: Schema.optional(AuthPayload),
});

const AddStdioSourcePayload = Schema.Struct({
  transport: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(StringMap),
  cwd: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});

const AddSourcePayload = Schema.Union(AddRemoteSourcePayload, AddStdioSourcePayload);

// ---------------------------------------------------------------------------
// Other payloads
// ---------------------------------------------------------------------------

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  headers: Schema.optional(SecretBackedMap),
  queryParams: Schema.optional(SecretBackedMap),
  auth: Schema.optional(AuthPayload),
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
});

const ProbeEndpointPayload = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(SecretBackedMap),
  queryParams: Schema.optional(SecretBackedMap),
});

const ProbeEndpointResponse = Schema.Struct({
  connected: Schema.Boolean,
  requiresOAuth: Schema.Boolean,
  name: Schema.String,
  namespace: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  serverName: Schema.NullOr(Schema.String),
});

const NamespacePayload = Schema.Struct({
  namespace: Schema.String,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddSourceResponse = Schema.Struct({
  toolCount: Schema.Number,
  namespace: Schema.String,
});

const RefreshSourceResponse = Schema.Struct({
  toolCount: Schema.Number,
});

const RemoveSourceResponse = Schema.Struct({
  removed: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (McpOAuthError etc.) are declared once at the group
// level via `.addError(...)` — every endpoint inherits them. The errors
// themselves carry their HTTP status via `HttpApiSchema.annotations`
// in errors.ts, so handlers just `return yield* ext.foo(...)` and the
// schema encodes whatever it gets.
//
// 5xx is handled at the API level: `CoreExecutorApi.addError(InternalError)`
// adds a single shared opaque-by-schema 500 surface to every endpoint in
// the entire API. Defects are captured + downgraded to it by an
// HttpApiBuilder middleware (see apps/cloud/src/observability.ts).
// No per-handler wrapping, no per-plugin InternalError.
// ---------------------------------------------------------------------------

export class McpGroup extends HttpApiGroup.make("mcp")
  .add(
    HttpApiEndpoint.post("probeEndpoint")`/scopes/${scopeIdParam}/mcp/probe`
      .setPayload(ProbeEndpointPayload)
      .addSuccess(ProbeEndpointResponse),
  )
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/mcp/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse),
  )
  .add(
    HttpApiEndpoint.post("removeSource")`/scopes/${scopeIdParam}/mcp/sources/remove`
      .setPayload(NamespacePayload)
      .addSuccess(RemoveSourceResponse),
  )
  .add(
    HttpApiEndpoint.post("refreshSource")`/scopes/${scopeIdParam}/mcp/sources/refresh`
      .setPayload(NamespacePayload)
      .addSuccess(RefreshSourceResponse),
  )
  .add(
    HttpApiEndpoint.get(
      "getSource",
    )`/scopes/${scopeIdParam}/mcp/sources/${namespaceParam}`.addSuccess(
      Schema.NullOr(McpStoredSourceSchema),
    ),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/mcp/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  )
  // Errors declared once at the group level — every endpoint inherits.
  // Plugin domain errors carry their own HttpApiSchema status (4xx);
  // `InternalError` is the shared opaque 500 translated at the HTTP
  // edge by `withCapture`. We only list errors an MCP *group*
  // endpoint can surface: `McpInvocationError` is thrown inside
  // `invokeTool` which is reached via the core `tools.invoke`
  // endpoint, not any MCP-group endpoint, so it doesn't belong here.
  // OAuth errors live on the shared `/oauth/*` group in `@executor-js/api`
  // now — the MCP group only declares its own plugin-domain errors.
  .addError(InternalError)
  .addError(McpConnectionError)
  .addError(McpToolDiscoveryError) {}
