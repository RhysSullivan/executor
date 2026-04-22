import { Schema } from "effect";

// ---------------------------------------------------------------------------
// GraphQL operation kind
// ---------------------------------------------------------------------------

export const GraphqlOperationKind = Schema.Literal("query", "mutation");
export type GraphqlOperationKind = typeof GraphqlOperationKind.Type;

// ---------------------------------------------------------------------------
// Auth — how the endpoint authenticates. Three mutually exclusive shapes,
// mirroring the MCP plugin so scope shadowing of a stored `connectionId`
// lets each user carry their own token against a shared source row.
// ---------------------------------------------------------------------------

export const GraphqlConnectionAuth = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("header"),
    headerName: Schema.String,
    secretId: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    /** Stable per-source id. Callers mint this once (typically
     *  `graphql-oauth2-<namespace>`) and persist it on the source's auth
     *  config; `ctx.connections.accessToken(id)` resolves to the caller's
     *  scoped connection row at invoke time. */
    connectionId: Schema.String,
  }),
);
export type GraphqlConnectionAuth = typeof GraphqlConnectionAuth.Type;

// ---------------------------------------------------------------------------
// Extracted field (becomes a tool)
// ---------------------------------------------------------------------------

export class GraphqlArgument extends Schema.Class<GraphqlArgument>("GraphqlArgument")({
  name: Schema.String,
  typeName: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

export class ExtractedField extends Schema.Class<ExtractedField>("ExtractedField")({
  /** e.g. "user", "createUser" */
  fieldName: Schema.String,
  /** "query" or "mutation" */
  kind: GraphqlOperationKind,
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
  arguments: Schema.Array(GraphqlArgument),
  /** JSON Schema for the input (built from arguments) */
  inputSchema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  /** The return type name for documentation */
  returnTypeName: Schema.String,
}) {}

export class ExtractionResult extends Schema.Class<ExtractionResult>("ExtractionResult")({
  /** Schema name from introspection */
  schemaName: Schema.optionalWith(Schema.String, { as: "Option" }),
  fields: Schema.Array(ExtractedField),
}) {}

// ---------------------------------------------------------------------------
// Operation binding — minimal data needed to invoke
// ---------------------------------------------------------------------------

export class OperationBinding extends Schema.Class<OperationBinding>("OperationBinding")({
  kind: GraphqlOperationKind,
  fieldName: Schema.String,
  /** The full GraphQL query/mutation string */
  operationString: Schema.String,
  /** Ordered variable names for mapping */
  variableNames: Schema.Array(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export const HeaderValue = Schema.Union(
  Schema.String,
  Schema.Struct({
    secretId: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
);
export type HeaderValue = typeof HeaderValue.Type;

export class InvocationConfig extends Schema.Class<InvocationConfig>("InvocationConfig")({
  /** The GraphQL endpoint URL */
  endpoint: Schema.String,
  /** Headers applied to every request. Values can reference secrets. */
  headers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: HeaderValue }), {
    default: () => ({}),
  }),
}) {}

export class InvocationResult extends Schema.Class<InvocationResult>("InvocationResult")({
  status: Schema.Number,
  data: Schema.NullOr(Schema.Unknown),
  errors: Schema.NullOr(Schema.Unknown),
}) {}
