import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { SourceIdSchema, ToolArtifactIdSchema, WorkspaceIdSchema } from "../ids";

export const ToolArtifactSchema = Schema.Struct({
  id: ToolArtifactIdSchema,
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  sourceHash: Schema.String,
  toolCount: Schema.Number,
  manifestJson: Schema.String,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type ToolArtifact = typeof ToolArtifactSchema.Type;
