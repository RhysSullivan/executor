import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export const OperationId = Schema.String.pipe(Schema.brand("OperationId"));
export type OperationId = typeof OperationId.Type;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export class NoAuth extends Schema.TaggedClass<NoAuth>()("NoAuth", {}) {}

export class BearerAuth extends Schema.TaggedClass<BearerAuth>()(
  "BearerAuth",
  {
    token: Schema.String,
    headerName: Schema.optionalWith(Schema.String, { default: () => "Authorization" }),
    prefix: Schema.optionalWith(Schema.String, { default: () => "Bearer " }),
  },
) {}

export class ApiKeyAuth extends Schema.TaggedClass<ApiKeyAuth>()(
  "ApiKeyAuth",
  {
    name: Schema.String,
    value: Schema.String,
    in: Schema.Literal("header", "query", "cookie"),
  },
) {}

export const AuthConfig = Schema.Union(NoAuth, BearerAuth, ApiKeyAuth);
export type AuthConfig = typeof AuthConfig.Type;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const HttpMethod = Schema.Literal(
  "get", "put", "post", "delete", "patch", "head", "options", "trace",
);
export type HttpMethod = typeof HttpMethod.Type;

export const ParameterLocation = Schema.Literal("path", "query", "header", "cookie");
export type ParameterLocation = typeof ParameterLocation.Type;

// ---------------------------------------------------------------------------
// Extracted operation
// ---------------------------------------------------------------------------

export class OperationParameter extends Schema.Class<OperationParameter>(
  "OperationParameter",
)({
  name: Schema.String,
  location: ParameterLocation,
  required: Schema.Boolean,
  schema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  style: Schema.optionalWith(Schema.String, { as: "Option" }),
  explode: Schema.optionalWith(Schema.Boolean, { as: "Option" }),
  allowReserved: Schema.optionalWith(Schema.Boolean, { as: "Option" }),
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

export class OperationRequestBody extends Schema.Class<OperationRequestBody>(
  "OperationRequestBody",
)({
  required: Schema.Boolean,
  contentType: Schema.String,
  schema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
}) {}

export class ExtractedOperation extends Schema.Class<ExtractedOperation>(
  "ExtractedOperation",
)({
  operationId: OperationId,
  method: HttpMethod,
  pathTemplate: Schema.String,
  summary: Schema.optionalWith(Schema.String, { as: "Option" }),
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
  tags: Schema.Array(Schema.String),
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.optionalWith(OperationRequestBody, { as: "Option" }),
  inputSchema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  outputSchema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  deprecated: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}) {}

export class ServerInfo extends Schema.Class<ServerInfo>("ServerInfo")({
  url: Schema.String,
  variables: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { as: "Option" },
  ),
}) {}

export class ExtractionResult extends Schema.Class<ExtractionResult>(
  "ExtractionResult",
)({
  title: Schema.optionalWith(Schema.String, { as: "Option" }),
  version: Schema.optionalWith(Schema.String, { as: "Option" }),
  servers: Schema.Array(ServerInfo),
  operations: Schema.Array(ExtractedOperation),
}) {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export class InvocationConfig extends Schema.Class<InvocationConfig>(
  "InvocationConfig",
)({
  baseUrl: Schema.String,
  auth: AuthConfig,
}) {}

export class InvocationResult extends Schema.Class<InvocationResult>(
  "InvocationResult",
)({
  status: Schema.Number,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
}) {}
