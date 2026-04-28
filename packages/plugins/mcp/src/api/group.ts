import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";
import { InternalError } from "@executor/api";

import {
  McpConnectionError,
  McpOAuthError,
  McpToolDiscoveryError,
} from "../sdk/errors";
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

const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });

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
  queryParams: Schema.optional(StringMap),
  headers: Schema.optional(StringMap),
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
  headers: Schema.optional(StringMap),
  queryParams: Schema.optional(StringMap),
  auth: Schema.optional(AuthPayload),
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
});

const ProbeEndpointPayload = Schema.Struct({
  endpoint: Schema.String,
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

const StartOAuthPayload = Schema.Struct({
  endpoint: Schema.String,
  redirectUrl: Schema.String,
  queryParams: Schema.optional(Schema.NullOr(StringMap)),
  /** Pre-decided SDK connection id the exchange will mint. Caller
   *  passes a stable value (`mcp-oauth2-${namespace}`) so every user
   *  signing in against the same source writes to the same id at their
   *  own scope — the source's stored `{kind: "oauth2", connectionId}`
   *  then resolves per-user via shadowing. */
  connectionId: Schema.String,
  /** Source-level OAuth state captured by a previous user's flow. When
   *  passed, DCR is skipped — the same client_id is re-used so the
   *  source's auth config stays stable across users. */
  clientInformation: Schema.optional(Schema.NullOr(JsonObject)),
  authorizationServerUrl: Schema.optional(Schema.NullOr(Schema.String)),
  resourceMetadataUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const CompleteOAuthPayload = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

const OAuthCallbackParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const HtmlResponse = HttpApiSchema.Text({ contentType: "text/html" });

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

const StartOAuthResponse = Schema.Struct({
  sessionId: Schema.String,
  authorizationUrl: Schema.String,
});

const CompleteOAuthResponse = Schema.Struct({
  /** Id of the SDK Connection minted by the exchange. The UI stores it
   *  on the source's auth config as `{kind: "oauth2", connectionId}`. */
  connectionId: Schema.String,
  tokenType: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  /** DCR client + discovery URLs captured during the flow. Persisted
   *  on the source's auth config so subsequent users skip DCR + re-
   *  discovery. */
  clientInformation: Schema.NullOr(JsonObject),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
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
    HttpApiEndpoint.post("startOAuth")`/scopes/${scopeIdParam}/mcp/oauth/start`
      .setPayload(StartOAuthPayload)
      .addSuccess(StartOAuthResponse),
  )
  .add(
    HttpApiEndpoint.post("completeOAuth")`/scopes/${scopeIdParam}/mcp/oauth/complete`
      .setPayload(CompleteOAuthPayload)
      .addSuccess(CompleteOAuthResponse),
  )
  .add(
    HttpApiEndpoint.get("oauthCallback")`/mcp/oauth/callback`
      .setUrlParams(OAuthCallbackParams)
      .addSuccess(HtmlResponse),
  )
  .add(
    HttpApiEndpoint.get("getSource")`/scopes/${scopeIdParam}/mcp/sources/${namespaceParam}`
      .addSuccess(Schema.NullOr(McpStoredSourceSchema)),
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
  .addError(InternalError)
  .addError(McpOAuthError)
  .addError(McpConnectionError)
  .addError(McpToolDiscoveryError) {}
