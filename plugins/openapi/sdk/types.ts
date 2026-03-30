import * as Schema from "effect/Schema";

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

export const OpenApiHttpMethodSchema = Schema.Literal(...OPEN_API_HTTP_METHODS);
export const OpenApiParameterLocationSchema = Schema.Literal(
  ...OPEN_API_PARAMETER_LOCATIONS,
);

export const OpenApiExampleSchema = Schema.Struct({
  valueJson: Schema.String,
  mediaType: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
});

export const OpenApiMediaContentSchema = Schema.Struct({
  mediaType: Schema.String,
  schema: Schema.optional(Schema.Unknown),
  examples: Schema.optional(Schema.Array(OpenApiExampleSchema)),
});

export const OpenApiHeaderSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  deprecated: Schema.optional(Schema.Boolean),
  schema: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Array(OpenApiMediaContentSchema)),
  style: Schema.optional(Schema.String),
  explode: Schema.optional(Schema.Boolean),
  examples: Schema.optional(Schema.Array(OpenApiExampleSchema)),
});

export const OpenApiToolParameterSchema = Schema.Struct({
  name: Schema.String,
  location: OpenApiParameterLocationSchema,
  required: Schema.Boolean,
  style: Schema.optional(Schema.String),
  explode: Schema.optional(Schema.Boolean),
  allowReserved: Schema.optional(Schema.Boolean),
  content: Schema.optional(Schema.Array(OpenApiMediaContentSchema)),
});

export const OpenApiToolRequestBodySchema = Schema.Struct({
  required: Schema.Boolean,
  contentTypes: Schema.Array(Schema.String),
  contents: Schema.optional(Schema.Array(OpenApiMediaContentSchema)),
});

export const OpenApiServerSchema = Schema.Struct({
  url: Schema.String,
  description: Schema.optional(Schema.String),
  variables: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

export const OpenApiInvocationPayloadSchema = Schema.Struct({
  method: OpenApiHttpMethodSchema,
  pathTemplate: Schema.String,
  parameters: Schema.Array(OpenApiToolParameterSchema),
  requestBody: Schema.NullOr(OpenApiToolRequestBodySchema),
});

export const OpenApiParameterDocumentationSchema = Schema.Struct({
  name: Schema.String,
  location: OpenApiParameterLocationSchema,
  required: Schema.Boolean,
  description: Schema.optional(Schema.String),
  examples: Schema.optional(Schema.Array(OpenApiExampleSchema)),
});

export const OpenApiRequestBodyDocumentationSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  examples: Schema.optional(Schema.Array(OpenApiExampleSchema)),
});

export const OpenApiResponseDocumentationSchema = Schema.Struct({
  statusCode: Schema.String,
  description: Schema.optional(Schema.String),
  contentTypes: Schema.Array(Schema.String),
  examples: Schema.optional(Schema.Array(OpenApiExampleSchema)),
});

export const OpenApiToolDocumentationSchema = Schema.Struct({
  summary: Schema.optional(Schema.String),
  deprecated: Schema.optional(Schema.Boolean),
  parameters: Schema.Array(OpenApiParameterDocumentationSchema),
  requestBody: Schema.optional(OpenApiRequestBodyDocumentationSchema),
  response: Schema.optional(OpenApiResponseDocumentationSchema),
});

export type OpenApiSecurityRequirement =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "scheme";
      readonly schemeName: string;
      readonly scopes?: readonly string[];
    }
  | {
      readonly kind: "allOf";
      readonly items: readonly OpenApiSecurityRequirement[];
    }
  | {
      readonly kind: "anyOf";
      readonly items: readonly OpenApiSecurityRequirement[];
    };

export const OpenApiSecurityRequirementSchema = Schema.suspend(() =>
  Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("none"),
    }),
    Schema.Struct({
      kind: Schema.Literal("scheme"),
      schemeName: Schema.String,
      scopes: Schema.optional(Schema.Array(Schema.String)),
    }),
    Schema.Struct({
      kind: Schema.Literal("allOf"),
      items: Schema.Array(OpenApiSecurityRequirementSchema),
    }),
    Schema.Struct({
      kind: Schema.Literal("anyOf"),
      items: Schema.Array(OpenApiSecurityRequirementSchema),
    }),
  )
) as Schema.Schema<OpenApiSecurityRequirement, OpenApiSecurityRequirement, never>;

export const OpenApiSecuritySchemeTypeSchema = Schema.Literal(
  "apiKey",
  "http",
  "oauth2",
  "openIdConnect",
);

export const OpenApiOAuthFlowSchema = Schema.Struct({
  authorizationUrl: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
  refreshUrl: Schema.optional(Schema.String),
  scopes: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

export const OpenApiSecuritySchemeSchema = Schema.Struct({
  schemeName: Schema.String,
  schemeType: OpenApiSecuritySchemeTypeSchema,
  description: Schema.optional(Schema.String),
  placementIn: Schema.optional(Schema.Literal("header", "query", "cookie")),
  placementName: Schema.optional(Schema.String),
  scheme: Schema.optional(Schema.String),
  bearerFormat: Schema.optional(Schema.String),
  openIdConnectUrl: Schema.optional(Schema.String),
  flows: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: OpenApiOAuthFlowSchema,
    }),
  ),
});

export const OpenApiResponseVariantSchema = Schema.Struct({
  statusCode: Schema.String,
  description: Schema.optional(Schema.String),
  contentTypes: Schema.Array(Schema.String),
  schema: Schema.optional(Schema.Unknown),
  examples: Schema.optional(Schema.Array(OpenApiExampleSchema)),
  contents: Schema.optional(Schema.Array(OpenApiMediaContentSchema)),
  headers: Schema.optional(Schema.Array(OpenApiHeaderSchema)),
});

export const OpenApiToolProviderDataSchema = Schema.Struct({
  kind: Schema.Literal("openapi"),
  toolId: Schema.String,
  rawToolId: Schema.String,
  operationId: Schema.optional(Schema.String),
  group: Schema.String,
  leaf: Schema.String,
  tags: Schema.Array(Schema.String),
  versionSegment: Schema.optional(Schema.String),
  method: OpenApiHttpMethodSchema,
  path: Schema.String,
  operationHash: Schema.String,
  invocation: OpenApiInvocationPayloadSchema,
  documentation: Schema.optional(OpenApiToolDocumentationSchema),
  responses: Schema.optional(Schema.Array(OpenApiResponseVariantSchema)),
  authRequirement: Schema.optional(OpenApiSecurityRequirementSchema),
  securitySchemes: Schema.optional(Schema.Array(OpenApiSecuritySchemeSchema)),
  documentServers: Schema.optional(Schema.Array(OpenApiServerSchema)),
  servers: Schema.optional(Schema.Array(OpenApiServerSchema)),
});

export const OpenApiExecutableBindingSchema = Schema.Struct({
  kind: Schema.Literal("openapi"),
  toolId: Schema.String,
  operationId: Schema.optional(Schema.String),
  invocation: OpenApiInvocationPayloadSchema,
  documentServers: Schema.optional(Schema.Array(OpenApiServerSchema)),
  servers: Schema.optional(Schema.Array(OpenApiServerSchema)),
});

export type OpenApiHttpMethod = typeof OpenApiHttpMethodSchema.Type;
export type OpenApiExample = typeof OpenApiExampleSchema.Type;
export type OpenApiMediaContent = typeof OpenApiMediaContentSchema.Type;
export type OpenApiHeader = typeof OpenApiHeaderSchema.Type;
export type OpenApiToolParameter = typeof OpenApiToolParameterSchema.Type;
export type OpenApiToolRequestBody = typeof OpenApiToolRequestBodySchema.Type;
export type OpenApiServer = typeof OpenApiServerSchema.Type;
export type OpenApiInvocationPayload = typeof OpenApiInvocationPayloadSchema.Type;
export type OpenApiParameterDocumentation =
  typeof OpenApiParameterDocumentationSchema.Type;
export type OpenApiRequestBodyDocumentation =
  typeof OpenApiRequestBodyDocumentationSchema.Type;
export type OpenApiResponseDocumentation =
  typeof OpenApiResponseDocumentationSchema.Type;
export type OpenApiToolDocumentation =
  typeof OpenApiToolDocumentationSchema.Type;
export type OpenApiSecurityScheme =
  typeof OpenApiSecuritySchemeSchema.Type;
export type OpenApiResponseVariant =
  typeof OpenApiResponseVariantSchema.Type;
export type OpenApiToolProviderData =
  typeof OpenApiToolProviderDataSchema.Type;
export type OpenApiExecutableBinding =
  typeof OpenApiExecutableBindingSchema.Type;

export type OpenApiJsonPrimitive = string | number | boolean | null;
export type OpenApiJsonValue =
  | OpenApiJsonPrimitive
  | OpenApiJsonObject
  | Array<OpenApiJsonValue>;
export type OpenApiJsonObject = {
  [key: string]: OpenApiJsonValue;
};

export type OpenApiExtractedTool = {
  toolId: string;
  operationId?: string;
  tags: readonly string[];
  name: string;
  description: string | null;
  method: OpenApiHttpMethod;
  path: string;
  invocation: OpenApiInvocationPayload;
  operationHash: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  documentation?: OpenApiToolDocumentation;
  responses?: readonly OpenApiResponseVariant[];
  authRequirement?: OpenApiSecurityRequirement;
  securitySchemes?: readonly OpenApiSecurityScheme[];
  documentServers?: readonly OpenApiServer[];
  servers?: readonly OpenApiServer[];
};

export type OpenApiToolManifest = {
  version: 1;
  sourceHash: string;
  tools: readonly OpenApiExtractedTool[];
};

export type OpenApiToolDefinition = {
  toolId: string;
  rawToolId: string;
  operationId?: string;
  name: string;
  description: string;
  group: string;
  leaf: string;
  tags: readonly string[];
  versionSegment?: string;
  method: OpenApiHttpMethod;
  path: string;
  invocation: OpenApiInvocationPayload;
  operationHash: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  documentation?: OpenApiToolDocumentation;
  responses?: readonly OpenApiResponseVariant[];
  authRequirement?: OpenApiSecurityRequirement;
  securitySchemes?: readonly OpenApiSecurityScheme[];
  documentServers?: readonly OpenApiServer[];
  servers?: readonly OpenApiServer[];
};
