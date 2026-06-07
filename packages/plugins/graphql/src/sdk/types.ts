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
// Operation binding — minimal data needed to invoke
// ---------------------------------------------------------------------------

export const OperationBinding = Schema.Struct({
  kind: GraphqlOperationKind,
  fieldName: Schema.String,
  /** The full GraphQL query/mutation string */
  operationString: Schema.String,
  /** Ordered variable names for mapping */
  variableNames: Schema.Array(Schema.String),
});
export type OperationBinding = typeof OperationBinding.Type;

// ---------------------------------------------------------------------------
// Authentication template (v2)
//
// The integration's `config.authenticationTemplate` describes WHERE a
// connection's resolved value is applied: an apiKey header / query param (with
// an optional prefix like `Bearer `) or an OAuth bearer header. There are no
// secret slots and no credential bindings — a connection IS the credential, and
// the plugin renders `credential.value` onto the request through the template
// matched by `credential.template` (D11: "auth state derived into the
// auth-template format" — an OAuth access token renders exactly like an apiKey
// bearer).
// ---------------------------------------------------------------------------

/** An apiKey-style template: place the value in a header or query parameter,
 *  optionally prefixed (e.g. `Bearer `). */
export const ApiKeyAuthTemplate = Schema.Struct({
  kind: Schema.Literal("apiKey"),
  /** The template slug a connection references via `connection.template`. */
  slug: Schema.String,
  in: Schema.Literals(["header", "query"]),
  /** The header / query-parameter name the value is written to. */
  name: Schema.String,
  /** Optional prefix prepended to the value (e.g. `Bearer `). */
  prefix: Schema.optional(Schema.String),
});
export type ApiKeyAuthTemplate = typeof ApiKeyAuthTemplate.Type;

/** An OAuth bearer template: write `Authorization: Bearer <access-token>`. The
 *  resolved (and refreshed) access token is `credential.value`. */
export const OAuthAuthTemplate = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  slug: Schema.String,
  /** The header to write the bearer token to. Defaults to `Authorization`. */
  header: Schema.optional(Schema.String),
  /** The token prefix. Defaults to `Bearer `. */
  prefix: Schema.optional(Schema.String),
});
export type OAuthAuthTemplate = typeof OAuthAuthTemplate.Type;

export const AuthTemplate = Schema.Union([ApiKeyAuthTemplate, OAuthAuthTemplate]);
export type AuthTemplate = typeof AuthTemplate.Type;

// ---------------------------------------------------------------------------
// Integration config — the opaque-to-core blob the graphql plugin stores on the
// integration row. Holds everything `resolveTools` (introspection) and
// `invokeTool` (request building + auth rendering) need.
// ---------------------------------------------------------------------------

export const GraphqlIntegrationConfig = Schema.Struct({
  /** The GraphQL endpoint URL. */
  endpoint: Schema.String,
  /** Display name for the integration. */
  name: Schema.String,
  /** Optional introspection JSON text (when the endpoint doesn't support
   *  live introspection). */
  introspectionJson: Schema.optional(Schema.String),
  /** Static headers applied to every request (and to add-time introspection). */
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Static query parameters applied to every request. */
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Auth methods a connection can be applied through. */
  authenticationTemplate: Schema.Array(AuthTemplate),
});
export type GraphqlIntegrationConfig = typeof GraphqlIntegrationConfig.Type;

export const decodeGraphqlIntegrationConfig = Schema.decodeUnknownEffect(GraphqlIntegrationConfig);
export const decodeGraphqlIntegrationConfigOption =
  Schema.decodeUnknownOption(GraphqlIntegrationConfig);

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export const InvocationResult = Schema.Struct({
  status: Schema.Number,
  data: Schema.NullOr(Schema.Unknown),
  errors: Schema.NullOr(Schema.Unknown),
});
export type InvocationResult = typeof InvocationResult.Type;
