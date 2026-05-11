import { Effect, Schema } from "effect";
import {
  ConfiguredCredentialValue,
  CredentialBindingValue,
  credentialSlotKey,
  ScopedSecretCredentialInput,
  SecretBackedValue,
  ScopeId,
} from "@executor-js/sdk/core";

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
// Invocation
// ---------------------------------------------------------------------------

export const HeaderValue = SecretBackedValue;
export type HeaderValue = typeof HeaderValue.Type;
export const QueryParamValue = HeaderValue;
export type QueryParamValue = typeof QueryParamValue.Type;

export const ConfiguredGraphqlCredentialValue = ConfiguredCredentialValue;
export type ConfiguredGraphqlCredentialValue = typeof ConfiguredGraphqlCredentialValue.Type;
export const GraphqlCredentialInput = Schema.Union([
  ScopedSecretCredentialInput,
  HeaderValue,
  ConfiguredGraphqlCredentialValue,
]);
export type GraphqlCredentialInput = typeof GraphqlCredentialInput.Type;

export const graphqlHeaderSlot = (name: string): string => credentialSlotKey("header", name);
export const graphqlQueryParamSlot = (name: string): string =>
  credentialSlotKey("query_param", name);
export const GRAPHQL_OAUTH_CONNECTION_SLOT = "auth:oauth2:connection";

// ---------------------------------------------------------------------------
// Source auth
// ---------------------------------------------------------------------------

export const GraphqlSourceAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    connectionSlot: Schema.String,
  }),
]);
export type GraphqlSourceAuth = typeof GraphqlSourceAuth.Type;

export const GraphqlSourceAuthInput = Schema.Union([
  GraphqlSourceAuth,
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    connectionId: Schema.String,
  }),
]);
export type GraphqlSourceAuthInput = typeof GraphqlSourceAuthInput.Type;

export const GraphqlSourceBindingValue = CredentialBindingValue;
export type GraphqlSourceBindingValue = typeof GraphqlSourceBindingValue.Type;

export const GraphqlSourceBindingInput = Schema.Struct({
  sourceId: Schema.String,
  sourceScope: ScopeId,
  scope: ScopeId,
  slot: Schema.String,
  value: GraphqlSourceBindingValue,
});
export type GraphqlSourceBindingInput = typeof GraphqlSourceBindingInput.Type;

export const GraphqlSourceBindingRef = Schema.Struct({
  sourceId: Schema.String,
  sourceScopeId: ScopeId,
  scopeId: ScopeId,
  slot: Schema.String,
  value: GraphqlSourceBindingValue,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});
export type GraphqlSourceBindingRef = typeof GraphqlSourceBindingRef.Type;

export const InvocationConfig = Schema.Struct({
  /** The GraphQL endpoint URL */
  endpoint: Schema.String,
  /** Headers applied to every request. Values can reference secrets. */
  headers: Schema.Record(Schema.String, ConfiguredGraphqlCredentialValue).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    Schema.withConstructorDefault(Effect.succeed({})),
  ),
  /** Query parameters applied to every request. Values can reference secrets. */
  queryParams: Schema.Record(Schema.String, ConfiguredGraphqlCredentialValue).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    Schema.withConstructorDefault(Effect.succeed({})),
  ),
});
export type InvocationConfig = typeof InvocationConfig.Type;

export const InvocationResult = Schema.Struct({
  status: Schema.Number,
  data: Schema.NullOr(Schema.Unknown),
  errors: Schema.NullOr(Schema.Unknown),
});
export type InvocationResult = typeof InvocationResult.Type;
