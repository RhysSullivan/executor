import { Schema } from "effect";
import { GOOGLE_DISCOVERY_SOURCE_KIND } from "@executor/plugin-google-discovery-shared";

export const GOOGLE_DISCOVERY_HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
] as const;

export const GoogleDiscoveryHttpMethodSchema = Schema.Literal(
  ...GOOGLE_DISCOVERY_HTTP_METHODS,
);

export const GoogleDiscoveryParameterLocationSchema = Schema.Literal(
  "path",
  "query",
  "header",
);

export const GoogleDiscoveryMethodParameterSchema = Schema.Struct({
  name: Schema.String,
  location: GoogleDiscoveryParameterLocationSchema,
  required: Schema.Boolean,
  repeated: Schema.Boolean,
  description: Schema.NullOr(Schema.String),
  type: Schema.NullOr(Schema.String),
  enum: Schema.optional(Schema.Array(Schema.String)),
  default: Schema.optional(Schema.String),
});

export const GoogleDiscoveryInvocationPayloadSchema = Schema.Struct({
  method: GoogleDiscoveryHttpMethodSchema,
  path: Schema.String,
  flatPath: Schema.NullOr(Schema.String),
  rootUrl: Schema.String,
  servicePath: Schema.String,
  parameters: Schema.Array(GoogleDiscoveryMethodParameterSchema),
  requestSchemaId: Schema.NullOr(Schema.String),
  responseSchemaId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
  scopeDescriptions: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
  supportsMediaUpload: Schema.Boolean,
  supportsMediaDownload: Schema.Boolean,
});

export const GoogleDiscoveryToolProviderDataSchema = Schema.Struct({
  kind: Schema.Literal(GOOGLE_DISCOVERY_SOURCE_KIND),
  service: Schema.String,
  version: Schema.String,
  toolId: Schema.String,
  rawToolId: Schema.String,
  methodId: Schema.String,
  group: Schema.NullOr(Schema.String),
  leaf: Schema.String,
  invocation: GoogleDiscoveryInvocationPayloadSchema,
});

export const GoogleDiscoveryManifestMethodSchema = Schema.Struct({
  toolId: Schema.String,
  rawToolId: Schema.String,
  methodId: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  group: Schema.NullOr(Schema.String),
  leaf: Schema.String,
  method: GoogleDiscoveryHttpMethodSchema,
  path: Schema.String,
  flatPath: Schema.NullOr(Schema.String),
  parameters: Schema.Array(GoogleDiscoveryMethodParameterSchema),
  requestSchemaId: Schema.NullOr(Schema.String),
  responseSchemaId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
  supportsMediaUpload: Schema.Boolean,
  supportsMediaDownload: Schema.Boolean,
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
});

export const GoogleDiscoverySchemaRefTableSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});

export const GoogleDiscoveryToolManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  sourceHash: Schema.String,
  service: Schema.String,
  versionName: Schema.String,
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  rootUrl: Schema.String,
  servicePath: Schema.String,
  batchPath: Schema.NullOr(Schema.String),
  documentationLink: Schema.NullOr(Schema.String),
  oauthScopes: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
  schemaRefTable: Schema.optional(GoogleDiscoverySchemaRefTableSchema),
  methods: Schema.Array(GoogleDiscoveryManifestMethodSchema),
});

export type GoogleDiscoveryHttpMethod = typeof GoogleDiscoveryHttpMethodSchema.Type;
export type GoogleDiscoveryParameterLocation =
  typeof GoogleDiscoveryParameterLocationSchema.Type;
export type GoogleDiscoveryMethodParameter =
  typeof GoogleDiscoveryMethodParameterSchema.Type;
export type GoogleDiscoveryInvocationPayload =
  typeof GoogleDiscoveryInvocationPayloadSchema.Type;
export type GoogleDiscoveryToolProviderData =
  typeof GoogleDiscoveryToolProviderDataSchema.Type;
export type GoogleDiscoveryManifestMethod =
  typeof GoogleDiscoveryManifestMethodSchema.Type;
export type GoogleDiscoverySchemaRefTable =
  typeof GoogleDiscoverySchemaRefTableSchema.Type;
export type GoogleDiscoveryToolManifest =
  typeof GoogleDiscoveryToolManifestSchema.Type;

export type GoogleDiscoveryToolDefinition = GoogleDiscoveryManifestMethod;
