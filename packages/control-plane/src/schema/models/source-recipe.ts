import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import {
  sourceRecipeDocumentsTable,
  sourceRecipeOperationsTable,
  sourceRecipeSchemaBundlesTable,
  sourceRecipeRevisionsTable,
  sourceRecipesTable,
} from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import {
  SourceRecipeIdSchema,
  SourceRecipeRevisionIdSchema,
  SourceRecipeSchemaBundleIdSchema,
} from "../ids";

export const SourceRecipeKindSchema = Schema.Literal(
  "http_api",
  "mcp",
  "internal",
);

export const SourceRecipeAdapterKeySchema = Schema.String;

export const SourceRecipeVisibilitySchema = Schema.Literal(
  "private",
  "workspace",
  "organization",
  "public",
);

export const SourceRecipeDocumentKindSchema = Schema.String;

export const SourceRecipeSchemaBundleKindSchema = Schema.String;

export const SourceRecipeTransportKindSchema = Schema.Literal(
  "http",
  "graphql",
  "mcp",
  "internal",
);

export const SourceRecipeOperationKindSchema = Schema.Literal(
  "read",
  "write",
  "delete",
  "unknown",
);

export const SourceRecipeOperationProviderKindSchema = Schema.String;

const recipeRowSchemaOverrides = {
  id: SourceRecipeIdSchema,
  kind: SourceRecipeKindSchema,
  adapterKey: SourceRecipeAdapterKeySchema,
  visibility: SourceRecipeVisibilitySchema,
  latestRevisionId: SourceRecipeRevisionIdSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const recipeRevisionRowSchemaOverrides = {
  id: SourceRecipeRevisionIdSchema,
  recipeId: SourceRecipeIdSchema,
  revisionNumber: Schema.Number,
  materializationHash: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const recipeDocumentRowSchemaOverrides = {
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  documentKind: SourceRecipeDocumentKindSchema,
  fetchedAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const recipeSchemaBundleRowSchemaOverrides = {
  id: SourceRecipeSchemaBundleIdSchema,
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  bundleKind: SourceRecipeSchemaBundleKindSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const sourceRecipeOperationRowSchemaOverrides = {
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  transportKind: SourceRecipeTransportKindSchema,
  operationKind: SourceRecipeOperationKindSchema,
  providerKind: SourceRecipeOperationProviderKindSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const StoredSourceRecipeRecordSchema = createSelectSchema(
  sourceRecipesTable,
  recipeRowSchemaOverrides,
);

export const StoredSourceRecipeRevisionRecordSchema = createSelectSchema(
  sourceRecipeRevisionsTable,
  recipeRevisionRowSchemaOverrides,
);

export const StoredSourceRecipeDocumentRecordSchema = createSelectSchema(
  sourceRecipeDocumentsTable,
  recipeDocumentRowSchemaOverrides,
);

export const StoredSourceRecipeSchemaBundleRecordSchema = createSelectSchema(
  sourceRecipeSchemaBundlesTable,
  recipeSchemaBundleRowSchemaOverrides,
);

export const StoredSourceRecipeOperationRowSchema = createSelectSchema(
  sourceRecipeOperationsTable,
  sourceRecipeOperationRowSchemaOverrides,
);
export const StoredSourceRecipeOperationRecordSchema = StoredSourceRecipeOperationRowSchema.annotations({
  identifier: "StoredSourceRecipeOperationRecord",
});

export type SourceRecipeKind = typeof SourceRecipeKindSchema.Type;
export type SourceRecipeAdapterKey = typeof SourceRecipeAdapterKeySchema.Type;
export type SourceRecipeVisibility = typeof SourceRecipeVisibilitySchema.Type;
export type SourceRecipeDocumentKind = typeof SourceRecipeDocumentKindSchema.Type;
export type SourceRecipeSchemaBundleKind =
  typeof SourceRecipeSchemaBundleKindSchema.Type;
export type SourceRecipeTransportKind = typeof SourceRecipeTransportKindSchema.Type;
export type SourceRecipeOperationKind = typeof SourceRecipeOperationKindSchema.Type;
export type SourceRecipeOperationProviderKind =
  typeof SourceRecipeOperationProviderKindSchema.Type;
export type StoredSourceRecipeRecord = typeof StoredSourceRecipeRecordSchema.Type;
export type StoredSourceRecipeRevisionRecord = typeof StoredSourceRecipeRevisionRecordSchema.Type;
export type StoredSourceRecipeDocumentRecord = typeof StoredSourceRecipeDocumentRecordSchema.Type;
export type StoredSourceRecipeSchemaBundleRecord =
  typeof StoredSourceRecipeSchemaBundleRecordSchema.Type;
export type StoredSourceRecipeOperationRow = typeof StoredSourceRecipeOperationRowSchema.Type;
export type StoredSourceRecipeOperationRecord =
  typeof StoredSourceRecipeOperationRecordSchema.Type;
