import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Remote transport type
// ---------------------------------------------------------------------------

export const McpRemoteTransport = Schema.Literal("streamable-http", "sse", "auto");
export type McpRemoteTransport = typeof McpRemoteTransport.Type;

/** All transport types (used in the connector layer) */
export const McpTransport = Schema.Literal("streamable-http", "sse", "stdio", "auto");
export type McpTransport = typeof McpTransport.Type;

// ---------------------------------------------------------------------------
// Connection auth (only applies to remote sources)
// ---------------------------------------------------------------------------

export const McpConnectionAuth = Schema.Union(
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
    tokenType: Schema.optionalWith(Schema.String, { default: () => "Bearer" }),
    expiresAt: Schema.NullOr(Schema.Number),
    scope: Schema.NullOr(Schema.String),
  }),
);
export type McpConnectionAuth = typeof McpConnectionAuth.Type;

// ---------------------------------------------------------------------------
// Stored source data — discriminated union on transport
// ---------------------------------------------------------------------------

/** Common fields for remote string map schemas */
const StringMap = Schema.Record({ key: Schema.String, value: Schema.String });

export const McpRemoteSourceData = Schema.Struct({
  transport: Schema.Literal("remote"),
  /** The MCP server endpoint URL */
  endpoint: Schema.String,
  /** Transport preference for this remote source */
  remoteTransport: Schema.optionalWith(McpRemoteTransport, { default: () => "auto" as const }),
  /** Extra query params appended to the endpoint URL */
  queryParams: Schema.optional(StringMap),
  /** Extra headers sent on every request */
  headers: Schema.optional(StringMap),
  /** Auth configuration */
  auth: McpConnectionAuth,
});
export type McpRemoteSourceData = typeof McpRemoteSourceData.Type;

export const McpStdioSourceData = Schema.Struct({
  transport: Schema.Literal("stdio"),
  /** The command to run */
  command: Schema.String,
  /** Arguments to the command */
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Environment variables */
  env: Schema.optional(StringMap),
  /** Working directory */
  cwd: Schema.optional(Schema.String),
});
export type McpStdioSourceData = typeof McpStdioSourceData.Type;

export const McpStoredSourceData = Schema.Union(McpRemoteSourceData, McpStdioSourceData);
export type McpStoredSourceData = typeof McpStoredSourceData.Type;

// ---------------------------------------------------------------------------
// Tool binding — maps a registered ToolId back to the MCP tool name
// ---------------------------------------------------------------------------

export class McpToolBinding extends Schema.Class<McpToolBinding>("McpToolBinding")({
  toolId: Schema.String,
  toolName: Schema.String,
  description: Schema.NullOr(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
}) {}
