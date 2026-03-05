import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { SourceKindSchema, SourceStatusSchema } from "../enums";
import { SourceIdSchema, WorkspaceIdSchema } from "../ids";

export const SourceSchema = Schema.Struct({
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
});

export type Source = typeof SourceSchema.Type;
