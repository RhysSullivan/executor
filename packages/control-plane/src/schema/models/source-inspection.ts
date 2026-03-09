import { OpenApiHttpMethodSchema } from "@executor-v3/codemode-openapi";
import { Schema } from "effect";

import { SourceSchema } from "./source";

export const SourceInspectionPipelineKindSchema = Schema.Literal(
  "openapi",
  "graphql",
  "persisted",
);

export const SourceInspectionToolSummarySchema = Schema.Struct({
  path: Schema.String,
  sourceKey: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  providerKind: Schema.String,
  toolId: Schema.String,
  rawToolId: Schema.NullOr(Schema.String),
  operationId: Schema.NullOr(Schema.String),
  group: Schema.NullOr(Schema.String),
  leaf: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  method: Schema.NullOr(OpenApiHttpMethodSchema),
  pathTemplate: Schema.NullOr(Schema.String),
  inputType: Schema.optional(Schema.String),
  outputType: Schema.optional(Schema.String),
});

export const SourceInspectionSchema = Schema.Struct({
  source: SourceSchema,
  namespace: Schema.String,
  pipelineKind: SourceInspectionPipelineKindSchema,
  toolCount: Schema.Number,
  rawDocumentText: Schema.NullOr(Schema.String),
  manifestJson: Schema.NullOr(Schema.String),
  definitionsJson: Schema.NullOr(Schema.String),
  tools: Schema.Array(SourceInspectionToolSummarySchema),
});

export const SourceInspectionToolDetailSchema = Schema.Struct({
  summary: SourceInspectionToolSummarySchema,
  definitionJson: Schema.NullOr(Schema.String),
  documentationJson: Schema.NullOr(Schema.String),
  providerDataJson: Schema.NullOr(Schema.String),
  inputSchemaJson: Schema.NullOr(Schema.String),
  outputSchemaJson: Schema.NullOr(Schema.String),
  exampleInputJson: Schema.NullOr(Schema.String),
  exampleOutputJson: Schema.NullOr(Schema.String),
});

export const SourceInspectionDiscoverPayloadSchema = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
});

export const SourceInspectionDiscoverResultItemSchema = Schema.Struct({
  path: Schema.String,
  score: Schema.Number,
  description: Schema.optional(Schema.String),
  inputType: Schema.optional(Schema.String),
  outputType: Schema.optional(Schema.String),
  reasons: Schema.Array(Schema.String),
});

export const SourceInspectionDiscoverResultSchema = Schema.Struct({
  query: Schema.String,
  queryTokens: Schema.Array(Schema.String),
  bestPath: Schema.NullOr(Schema.String),
  total: Schema.Number,
  results: Schema.Array(SourceInspectionDiscoverResultItemSchema),
});

export type SourceInspectionPipelineKind =
  typeof SourceInspectionPipelineKindSchema.Type;
export type SourceInspectionToolSummary =
  typeof SourceInspectionToolSummarySchema.Type;
export type SourceInspection = typeof SourceInspectionSchema.Type;
export type SourceInspectionToolDetail =
  typeof SourceInspectionToolDetailSchema.Type;
export type SourceInspectionDiscoverPayload =
  typeof SourceInspectionDiscoverPayloadSchema.Type;
export type SourceInspectionDiscoverResultItem =
  typeof SourceInspectionDiscoverResultItemSchema.Type;
export type SourceInspectionDiscoverResult =
  typeof SourceInspectionDiscoverResultSchema.Type;
