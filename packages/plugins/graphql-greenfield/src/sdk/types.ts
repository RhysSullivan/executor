import { Schema } from "effect";

// ---------------------------------------------------------------------------
// GraphQL operation kind
// ---------------------------------------------------------------------------

export const GraphqlOperationKind = Schema.Literals(["query", "mutation"]);
export type GraphqlOperationKind = typeof GraphqlOperationKind.Type;

// ---------------------------------------------------------------------------
// Extracted field (becomes a tool)
// ---------------------------------------------------------------------------

export const GraphqlArgument = Schema.Struct({
  name: Schema.String,
  typeName: Schema.String,
  required: Schema.Boolean,
  description: Schema.OptionFromOptional(Schema.String),
});
export type GraphqlArgument = typeof GraphqlArgument.Type;

export const ExtractedField = Schema.Struct({
  /** e.g. "user", "createUser" */
  fieldName: Schema.String,
  /** "query" or "mutation" */
  kind: GraphqlOperationKind,
  description: Schema.OptionFromOptional(Schema.String),
  arguments: Schema.Array(GraphqlArgument),
  /** JSON Schema for the input (built from arguments) */
  inputSchema: Schema.OptionFromOptional(Schema.Unknown),
  /** The return type name for documentation */
  returnTypeName: Schema.String,
});
export type ExtractedField = typeof ExtractedField.Type;

export const ExtractionResult = Schema.Struct({
  /** Schema name from introspection */
  schemaName: Schema.OptionFromOptional(Schema.String),
  fields: Schema.Array(ExtractedField),
});
export type ExtractionResult = typeof ExtractionResult.Type;

// ---------------------------------------------------------------------------
// Operation binding — minimal data needed to invoke. Stored inside the
// integration's opaque config (one entry per tool name).
// ---------------------------------------------------------------------------

export const OperationBinding = Schema.Struct({
  /** The tool name — `query.hello`, `mutation.setGreeting`. */
  toolName: Schema.String,
  kind: GraphqlOperationKind,
  fieldName: Schema.String,
  /** The full GraphQL query/mutation string */
  operationString: Schema.String,
  /** Ordered variable names for mapping */
  variableNames: Schema.Array(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
});
export type OperationBinding = typeof OperationBinding.Type;

// ---------------------------------------------------------------------------
// Auth templates — v2 replaces v1's secret-backed header/query maps +
// credential bindings. An integration declares zero or more auth methods; a
// connection picks one by `template` slug, and `invokeTool` renders the
// connection's resolved value through it. (D11: "auth state derived into the
// auth-template format" — an OAuth access token renders exactly like an apiKey
// bearer because both arrive as a single resolved `value`.)
// ---------------------------------------------------------------------------

/** Apply the value as an HTTP header (e.g. `Authorization: Bearer <value>`). */
export const ApiKeyHeaderTemplate = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("apiKey"),
  in: Schema.Literal("header"),
  /** The header name to set. */
  name: Schema.String,
  /** Optional literal prefix prepended to the value (e.g. "Bearer "). */
  prefix: Schema.optional(Schema.String),
});
export type ApiKeyHeaderTemplate = typeof ApiKeyHeaderTemplate.Type;

/** Apply the value as a URL query parameter. */
export const ApiKeyQueryTemplate = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("apiKey"),
  in: Schema.Literal("query"),
  /** The query parameter name to set. */
  name: Schema.String,
  prefix: Schema.optional(Schema.String),
});
export type ApiKeyQueryTemplate = typeof ApiKeyQueryTemplate.Type;

/** Apply the (already-resolved, already-refreshed) OAuth access token as a
 *  bearer header. Renders identically to an apiKey header bound to the same
 *  header/prefix — the difference is only how the value was sourced. */
export const OAuthTemplate = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("oauth"),
  /** Header the token is written into. Defaults to `Authorization`. */
  header: Schema.optional(Schema.String),
  /** Prefix for the token. Defaults to `Bearer `. */
  prefix: Schema.optional(Schema.String),
  authorizationUrl: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.String)),
});
export type OAuthTemplate = typeof OAuthTemplate.Type;

export const AuthTemplate = Schema.Union([
  ApiKeyHeaderTemplate,
  ApiKeyQueryTemplate,
  OAuthTemplate,
]);
export type AuthTemplate = typeof AuthTemplate.Type;

// ---------------------------------------------------------------------------
// Integration config — the opaque blob the plugin stores on the integration
// row. Core never parses it; the plugin writes it at register time and reads
// it back in `resolveTools` (to produce tools) and `invokeTool` (to render
// auth + look up the operation).
// ---------------------------------------------------------------------------

export const GraphqlIntegrationConfig = Schema.Struct({
  /** The GraphQL endpoint URL. */
  endpoint: Schema.String,
  /** Optional introspection JSON (when the endpoint can't be reached live). */
  introspectionJson: Schema.optional(Schema.String),
  /** Auth methods a connection can apply through. */
  authentication: Schema.Array(AuthTemplate),
  /** Spec-derived operations, one per produced tool. */
  operations: Schema.Array(OperationBinding),
  /** Shared JSON-schema `$defs` reachable from the tools' `$ref`s. */
  definitions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type GraphqlIntegrationConfig = typeof GraphqlIntegrationConfig.Type;

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export const InvocationResult = Schema.Struct({
  status: Schema.Number,
  data: Schema.NullOr(Schema.Unknown),
  errors: Schema.NullOr(Schema.Unknown),
});
export type InvocationResult = typeof InvocationResult.Type;
