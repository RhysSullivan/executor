import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";

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
    accessTokenSecretId: Schema.String,
    refreshTokenSecretId: Schema.NullOr(Schema.String),
    tokenType: Schema.optional(Schema.String),
    expiresAt: Schema.NullOr(Schema.Number),
    scope: Schema.NullOr(Schema.String),
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
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
});

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class McpApiError extends Schema.TaggedError<McpApiError>()(
  "McpApiError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class McpInternalError extends Schema.TaggedError<McpInternalError>()(
  "McpInternalError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class McpGroup extends HttpApiGroup.make("mcp")
  .add(
    HttpApiEndpoint.post("probeEndpoint")`/scopes/${scopeIdParam}/mcp/probe`
      .setPayload(ProbeEndpointPayload)
      .addSuccess(ProbeEndpointResponse)
      .addError(McpApiError)
      .addError(McpInternalError),
  )
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/mcp/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse)
      .addError(McpApiError)
      .addError(McpInternalError),
  )
  .add(
    HttpApiEndpoint.post("removeSource")`/scopes/${scopeIdParam}/mcp/sources/remove`
      .setPayload(NamespacePayload)
      .addSuccess(RemoveSourceResponse)
      .addError(McpApiError)
      .addError(McpInternalError),
  )
  .add(
    HttpApiEndpoint.post("refreshSource")`/scopes/${scopeIdParam}/mcp/sources/refresh`
      .setPayload(NamespacePayload)
      .addSuccess(RefreshSourceResponse)
      .addError(McpApiError)
      .addError(McpInternalError),
  )
  .add(
    HttpApiEndpoint.post("startOAuth")`/scopes/${scopeIdParam}/mcp/oauth/start`
      .setPayload(StartOAuthPayload)
      .addSuccess(StartOAuthResponse)
      .addError(McpApiError)
      .addError(McpInternalError),
  )
  .add(
    HttpApiEndpoint.post("completeOAuth")`/scopes/${scopeIdParam}/mcp/oauth/complete`
      .setPayload(CompleteOAuthPayload)
      .addSuccess(CompleteOAuthResponse)
      .addError(McpApiError)
      .addError(McpInternalError),
  )
  .add(
    HttpApiEndpoint.get("oauthCallback")`/mcp/oauth/callback`
      .setUrlParams(OAuthCallbackParams)
      .addSuccess(HtmlResponse)
      .addError(McpApiError)
      .addError(McpInternalError),
  )
  .add(
    HttpApiEndpoint.get("getSource")`/scopes/${scopeIdParam}/mcp/sources/${namespaceParam}`
      .addSuccess(Schema.NullOr(McpStoredSourceSchema))
      .addError(McpApiError)
      .addError(McpInternalError),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/mcp/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse)
      .addError(McpApiError)
      .addError(McpInternalError),
  ) {}
