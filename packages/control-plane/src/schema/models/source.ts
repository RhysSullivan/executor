import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { sourcesTable } from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import { SourceIdSchema, WorkspaceIdSchema } from "../ids";

export const SourceKindSchema = Schema.Literal(
  "mcp",
  "openapi",
  "graphql",
  "internal",
);

export const SourceStatusSchema = Schema.Literal(
  "draft",
  "probing",
  "auth_required",
  "connected",
  "error",
);

const sourceRowSchemaOverrides = {
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  kind: SourceKindSchema,
  status: SourceStatusSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const SourceRowSchema = createSelectSchema(sourcesTable, sourceRowSchemaOverrides);

export const SourceInsertSchema = createInsertSchema(
  sourcesTable,
  sourceRowSchemaOverrides,
);

export const SourceUpdateSchema = createUpdateSchema(
  sourcesTable,
  sourceRowSchemaOverrides,
);

export const SourceSchema = Schema.transform(
  SourceRowSchema,
  Schema.Struct({
    id: SourceIdSchema,
    workspaceId: WorkspaceIdSchema,
    name: Schema.String,
    kind: SourceKindSchema,
    endpoint: Schema.String,
    status: SourceStatusSchema,
    enabled: Schema.Boolean,
    configJson: Schema.String,
    sourceHash: Schema.NullOr(Schema.String),
    lastError: Schema.NullOr(Schema.String),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }),
  {
    strict: false,
    decode: (row, _input) => ({
      id: row.sourceId,
      workspaceId: row.workspaceId,
      name: row.name,
      kind: row.kind,
      endpoint: row.endpoint,
      status: row.status,
      enabled: row.enabled,
      configJson: row.configJson,
      sourceHash: row.sourceHash,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    encode: (source, _output) => ({
      sourceId: source.id,
      workspaceId: source.workspaceId,
      name: source.name,
      kind: source.kind,
      endpoint: source.endpoint,
      status: source.status,
      enabled: source.enabled,
      configJson: source.configJson,
      sourceHash: source.sourceHash,
      lastError: source.lastError,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    }),
  },
);

export type SourceKind = typeof SourceKindSchema.Type;
export type SourceStatus = typeof SourceStatusSchema.Type;
export type Source = typeof SourceSchema.Type;
