import {
  Schema,
} from "effect";

import {
  TimestampMsSchema,
} from "../common";
import {
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
} from "../ids";

export const SourceCatalogKindSchema = Schema.Literal("imported");

export const SourceCatalogPluginKeySchema = Schema.String;

export const SourceCatalogVisibilitySchema = Schema.Literal(
  "private",
  "scope",
  "organization",
  "public",
);

export const StoredSourceCatalogRecordSchema = Schema.Struct({
  id: SourceCatalogIdSchema,
  kind: SourceCatalogKindSchema,
  pluginKey: SourceCatalogPluginKeySchema,
  name: Schema.String,
  summary: Schema.NullOr(Schema.String),
  visibility: SourceCatalogVisibilitySchema,
  latestRevisionId: SourceCatalogRevisionIdSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const StoredSourceCatalogRevisionRecordSchema = Schema.Struct({
  id: SourceCatalogRevisionIdSchema,
  catalogId: SourceCatalogIdSchema,
  revisionNumber: Schema.Number,
  sourceConfigJson: Schema.String,
  importMetadataJson: Schema.NullOr(Schema.String),
  importMetadataHash: Schema.NullOr(Schema.String),
  snapshotHash: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type SourceCatalogKind = typeof SourceCatalogKindSchema.Type;
export type SourceCatalogPluginKey = typeof SourceCatalogPluginKeySchema.Type;
export type SourceCatalogVisibility = typeof SourceCatalogVisibilitySchema.Type;
export type StoredSourceCatalogRecord = typeof StoredSourceCatalogRecordSchema.Type;
export type StoredSourceCatalogRevisionRecord = typeof StoredSourceCatalogRevisionRecordSchema.Type;
