import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Header values
//
// Three forms:
//   "static-value"                            — literal string
//   "secret-public-ref:my-token"              — secret reference (no prefix)
//   { value: "secret-public-ref:x", prefix }  — secret reference with prefix
// ---------------------------------------------------------------------------

export const SECRET_REF_PREFIX = "secret-public-ref:";

export const ConfigHeaderValue = Schema.Union(
  Schema.String,
  Schema.Struct({
    value: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
);
export type ConfigHeaderValue = typeof ConfigHeaderValue.Type;

const ConfigHeaders = Schema.Record({
  key: Schema.String,
  value: ConfigHeaderValue,
});

// ---------------------------------------------------------------------------
// Source configs — discriminated union on "kind"
// ---------------------------------------------------------------------------

export const OpenApiSourceConfig = Schema.Struct({
  kind: Schema.Literal("openapi"),
  spec: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(ConfigHeaders),
});
export type OpenApiSourceConfig = typeof OpenApiSourceConfig.Type;

export const GraphqlSourceConfig = Schema.Struct({
  kind: Schema.Literal("graphql"),
  endpoint: Schema.String,
  introspectionJson: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(ConfigHeaders),
});
export type GraphqlSourceConfig = typeof GraphqlSourceConfig.Type;

const StringMap = Schema.Record({ key: Schema.String, value: Schema.String });

export const McpAuthConfig = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("header"),
    headerName: Schema.String,
    secret: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    /** Stable id of the SDK Connection holding access + refresh token
     *  material. Scope shadowing means the same id resolves per-user
     *  via the executor's innermost-wins lookup. */
    connectionId: Schema.String,
  }),
);
export type McpAuthConfig = typeof McpAuthConfig.Type;

export const McpRemoteSourceConfig = Schema.Struct({
  kind: Schema.Literal("mcp"),
  transport: Schema.Literal("remote"),
  name: Schema.String,
  endpoint: Schema.String,
  remoteTransport: Schema.optional(Schema.Literal("streamable-http", "sse", "auto")),
  namespace: Schema.optional(Schema.String),
  queryParams: Schema.optional(StringMap),
  headers: Schema.optional(StringMap),
  auth: Schema.optional(McpAuthConfig),
});
export type McpRemoteSourceConfig = typeof McpRemoteSourceConfig.Type;

export const McpStdioSourceConfig = Schema.Struct({
  kind: Schema.Literal("mcp"),
  transport: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(StringMap),
  cwd: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});
export type McpStdioSourceConfig = typeof McpStdioSourceConfig.Type;

export const SourceConfig = Schema.Union(
  OpenApiSourceConfig,
  GraphqlSourceConfig,
  McpRemoteSourceConfig,
  McpStdioSourceConfig,
);
export type SourceConfig = typeof SourceConfig.Type;

// ---------------------------------------------------------------------------
// Secret metadata
// ---------------------------------------------------------------------------

export const SecretMetadata = Schema.Struct({
  name: Schema.String,
  provider: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
});
export type SecretMetadata = typeof SecretMetadata.Type;

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export const ExecutorFileConfig = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  sources: Schema.optional(Schema.Array(SourceConfig)),
  secrets: Schema.optional(Schema.Record({ key: Schema.String, value: SecretMetadata })),
});
export type ExecutorFileConfig = typeof ExecutorFileConfig.Type;
