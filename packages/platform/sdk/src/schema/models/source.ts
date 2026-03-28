import {
  Schema,
} from "effect";
export {
  SourceTransportSchema,
  StringMapSchema,
} from "@executor/source-core";
import {
  SourceTransportSchema,
  StringMapSchema,
} from "@executor/source-core";

import {
  TimestampMsSchema,
} from "../common";
import {
  SourceIdSchema,
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
  ScopeIdSchema,
} from "../ids";
export const SourceKindSchema = Schema.String;

export const SourceStatusSchema = Schema.Literal(
  "draft",
  "probing",
  "auth_required",
  "connected",
  "error",
);

const SourceStorageRowSchema = Schema.Struct({
  scopeId: ScopeIdSchema,
  sourceId: SourceIdSchema,
  catalogId: SourceCatalogIdSchema,
  catalogRevisionId: SourceCatalogRevisionIdSchema,
  name: Schema.String,
  kind: SourceKindSchema,
  status: SourceStatusSchema,
  enabled: Schema.Boolean,
  namespace: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const StoredSourceRecordSchema = Schema.transform(
  SourceStorageRowSchema,
  Schema.Struct({
    id: SourceIdSchema,
    scopeId: ScopeIdSchema,
    catalogId: SourceCatalogIdSchema,
    catalogRevisionId: SourceCatalogRevisionIdSchema,
    name: Schema.String,
    kind: SourceKindSchema,
    status: SourceStatusSchema,
    enabled: Schema.Boolean,
    namespace: Schema.NullOr(Schema.String),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }),
  {
    strict: false,
    decode: (row) => ({
      id: row.sourceId,
      scopeId: row.scopeId,
      catalogId: row.catalogId,
      catalogRevisionId: row.catalogRevisionId,
      name: row.name,
      kind: row.kind,
      status: row.status,
      enabled: row.enabled,
      namespace: row.namespace,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    encode: (source) => ({
      scopeId: source.scopeId,
      sourceId: source.id,
      catalogId: source.catalogId,
      catalogRevisionId: source.catalogRevisionId,
      name: source.name,
      kind: source.kind,
      status: source.status,
      enabled: source.enabled,
      namespace: source.namespace,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    }),
  },
);

export const SourceSchema = Schema.Struct({
  id: SourceIdSchema,
  scopeId: ScopeIdSchema,
  name: Schema.String,
  kind: SourceKindSchema,
  status: SourceStatusSchema,
  enabled: Schema.Boolean,
  namespace: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type SourceKind = typeof SourceKindSchema.Type;
export type SourceStatus = typeof SourceStatusSchema.Type;
export type SourceTransport = typeof SourceTransportSchema.Type;
export type StoredSourceRecord = typeof StoredSourceRecordSchema.Type;
export type StringMap = typeof StringMapSchema.Type;
export type Source = typeof SourceSchema.Type;
