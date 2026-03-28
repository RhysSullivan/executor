import * as Schema from "effect/Schema";

export const GraphqlToolKindSchema = Schema.Literal("request", "field");

export const GraphqlOperationTypeSchema = Schema.Literal("query", "mutation");

export const GraphqlToolProviderDataSchema = Schema.Struct({
  kind: Schema.Literal("graphql"),
  toolKind: GraphqlToolKindSchema,
  toolId: Schema.String,
  rawToolId: Schema.NullOr(Schema.String),
  group: Schema.NullOr(Schema.String),
  leaf: Schema.NullOr(Schema.String),
  fieldName: Schema.NullOr(Schema.String),
  operationType: Schema.NullOr(GraphqlOperationTypeSchema),
  operationName: Schema.NullOr(Schema.String),
  operationDocument: Schema.NullOr(Schema.String),
  queryTypeName: Schema.NullOr(Schema.String),
  mutationTypeName: Schema.NullOr(Schema.String),
  subscriptionTypeName: Schema.NullOr(Schema.String),
});

export type GraphqlToolKind = typeof GraphqlToolKindSchema.Type;
export type GraphqlOperationType = typeof GraphqlOperationTypeSchema.Type;
export type GraphqlToolProviderData = typeof GraphqlToolProviderDataSchema.Type;
