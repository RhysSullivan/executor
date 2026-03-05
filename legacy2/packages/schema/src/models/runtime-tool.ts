import { Schema } from "effect";

import { SourceKindSchema } from "../enums";
import { SourceIdSchema, WorkspaceIdSchema } from "../ids";

export const OPEN_API_HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

export const OPEN_API_PARAMETER_LOCATIONS = [
  "path",
  "query",
  "header",
  "cookie",
] as const;

export const ToolProviderKindSchema = Schema.Union(
  SourceKindSchema,
  Schema.Literal("in_memory"),
);

export const ToolInvocationModeSchema = Schema.Literal(
  "http",
  "mcp",
  "graphql",
  "in_memory",
);

export const ToolAvailabilitySchema = Schema.Literal(
  "local_only",
  "remote_capable",
);

export const OpenApiHttpMethodSchema = Schema.Literal(...OPEN_API_HTTP_METHODS);

export const OpenApiParameterLocationSchema = Schema.Literal(
  ...OPEN_API_PARAMETER_LOCATIONS,
);

export const OpenApiToolParameterSchema = Schema.Struct({
  name: Schema.String,
  location: OpenApiParameterLocationSchema,
  required: Schema.Boolean,
});

export const OpenApiToolRequestBodySchema = Schema.Struct({
  required: Schema.Boolean,
  contentTypes: Schema.Array(Schema.String),
});

export const OpenApiInvocationPayloadSchema = Schema.Struct({
  method: OpenApiHttpMethodSchema,
  pathTemplate: Schema.String,
  parameters: Schema.Array(OpenApiToolParameterSchema),
  requestBody: Schema.NullOr(OpenApiToolRequestBodySchema),
});

export const DiscoveryTypingPayloadSchema = Schema.Struct({
  inputSchemaJson: Schema.optional(Schema.String),
  outputSchemaJson: Schema.optional(Schema.String),
  refHintKeys: Schema.optional(Schema.Array(Schema.String)),
});

export const OpenApiExtractedToolSchema = Schema.Struct({
  toolId: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  method: OpenApiHttpMethodSchema,
  path: Schema.String,
  invocation: OpenApiInvocationPayloadSchema,
  operationHash: Schema.String,
  typing: Schema.optional(DiscoveryTypingPayloadSchema),
});

export const OpenApiToolManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  sourceHash: Schema.String,
  tools: Schema.Array(OpenApiExtractedToolSchema),
  refHintTable: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

const SourceBackedCanonicalToolDescriptorBaseSchema = Schema.Struct({
  sourceId: SourceIdSchema,
  workspaceId: WorkspaceIdSchema,
  toolId: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  availability: ToolAvailabilitySchema,
});

export const OpenApiCanonicalToolDescriptorSchema =
  SourceBackedCanonicalToolDescriptorBaseSchema.pipe(
    Schema.extend(
      Schema.Struct({
        providerKind: Schema.Literal("openapi"),
        invocationMode: Schema.Literal("http"),
        providerPayload: OpenApiInvocationPayloadSchema,
      }),
    ),
  );

export const McpCanonicalToolDescriptorSchema =
  SourceBackedCanonicalToolDescriptorBaseSchema.pipe(
    Schema.extend(
      Schema.Struct({
        providerKind: Schema.Literal("mcp"),
        invocationMode: Schema.Literal("mcp"),
        providerPayload: Schema.Unknown,
      }),
    ),
  );

export const GraphqlCanonicalToolDescriptorSchema =
  SourceBackedCanonicalToolDescriptorBaseSchema.pipe(
    Schema.extend(
      Schema.Struct({
        providerKind: Schema.Literal("graphql"),
        invocationMode: Schema.Literal("graphql"),
        providerPayload: Schema.Unknown,
      }),
    ),
  );

export const InternalCanonicalToolDescriptorSchema =
  SourceBackedCanonicalToolDescriptorBaseSchema.pipe(
    Schema.extend(
      Schema.Struct({
        providerKind: Schema.Literal("internal"),
        invocationMode: Schema.Literal("in_memory"),
        providerPayload: Schema.Unknown,
      }),
    ),
  );

export const InMemoryCanonicalToolDescriptorSchema = Schema.Struct({
  providerKind: Schema.Literal("in_memory"),
  sourceId: Schema.Null,
  workspaceId: Schema.Null,
  toolId: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  invocationMode: Schema.Literal("in_memory"),
  availability: ToolAvailabilitySchema,
  providerPayload: Schema.Unknown,
});

export const CanonicalToolDescriptorSchema = Schema.Union(
  OpenApiCanonicalToolDescriptorSchema,
  McpCanonicalToolDescriptorSchema,
  GraphqlCanonicalToolDescriptorSchema,
  InternalCanonicalToolDescriptorSchema,
  InMemoryCanonicalToolDescriptorSchema,
);

export const ToolDiscoveryResultSchema = Schema.Struct({
  sourceHash: Schema.NullOr(Schema.String),
  tools: Schema.Array(CanonicalToolDescriptorSchema),
});

export const ToolInvokeResultSchema = Schema.Struct({
  output: Schema.Unknown,
  isError: Schema.Boolean,
});

export type ToolProviderKind = typeof ToolProviderKindSchema.Type;
export type ToolInvocationMode = typeof ToolInvocationModeSchema.Type;
export type ToolAvailability = typeof ToolAvailabilitySchema.Type;

export type OpenApiHttpMethod = typeof OpenApiHttpMethodSchema.Type;
export type OpenApiParameterLocation = typeof OpenApiParameterLocationSchema.Type;
export type OpenApiToolParameter = typeof OpenApiToolParameterSchema.Type;
export type OpenApiToolRequestBody = typeof OpenApiToolRequestBodySchema.Type;
export type OpenApiInvocationPayload = typeof OpenApiInvocationPayloadSchema.Type;
export type DiscoveryTypingPayload = typeof DiscoveryTypingPayloadSchema.Type;
export type OpenApiExtractedTool = typeof OpenApiExtractedToolSchema.Type;
export type OpenApiToolManifest = typeof OpenApiToolManifestSchema.Type;

export type OpenApiCanonicalToolDescriptor =
  typeof OpenApiCanonicalToolDescriptorSchema.Type;
export type CanonicalToolDescriptor = typeof CanonicalToolDescriptorSchema.Type;
export type ToolDiscoveryResult = typeof ToolDiscoveryResultSchema.Type;
export type ToolInvokeResult = typeof ToolInvokeResultSchema.Type;
