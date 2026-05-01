import { Schema } from "effect";
import { SecretBackedValue } from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// GraphQL operation kind
// ---------------------------------------------------------------------------

export const GraphqlOperationKind = Schema.Literal("query", "mutation");
export type GraphqlOperationKind = typeof GraphqlOperationKind.Type;

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

export const HeaderValue = SecretBackedValue;
export type HeaderValue = typeof HeaderValue.Type;
export const QueryParamValue = HeaderValue;
export type QueryParamValue = typeof QueryParamValue.Type;

// ---------------------------------------------------------------------------
// Source auth
// ---------------------------------------------------------------------------

export const GraphqlSourceAuth = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    connectionId: Schema.String,
  }),
);
export type GraphqlSourceAuth = typeof GraphqlSourceAuth.Type;

export class InvocationConfig extends Schema.Class<InvocationConfig>("InvocationConfig")({
  /** The GraphQL endpoint URL */
  endpoint: Schema.String,
  /** Headers applied to every request. Values can reference secrets. */
  headers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: HeaderValue }), {
    default: () => ({}),
  }),
  /** Query parameters applied to every request. Values can reference secrets. */
  queryParams: Schema.optionalWith(Schema.Record({ key: Schema.String, value: QueryParamValue }), {
    default: () => ({}),
  }),
}) {}

export class InvocationResult extends Schema.Class<InvocationResult>("InvocationResult")({
  status: Schema.Number,
  data: Schema.NullOr(Schema.Unknown),
  errors: Schema.NullOr(Schema.Unknown),
}) {}
