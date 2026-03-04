import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { InteractionKindSchema, InteractionStatusSchema } from "../enums";
import { InteractionIdSchema, TaskRunIdSchema, WorkspaceIdSchema } from "../ids";

export const InteractionSchema = Schema.Struct({
  id: InteractionIdSchema,
  workspaceId: WorkspaceIdSchema,
  taskRunId: TaskRunIdSchema,
  callId: Schema.String,
  toolPath: Schema.String,
  kind: InteractionKindSchema,
  status: InteractionStatusSchema,
  title: Schema.String,
  requestJson: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  requestedAt: TimestampMsSchema,
  resolvedAt: Schema.NullOr(TimestampMsSchema),
  expiresAt: Schema.NullOr(TimestampMsSchema),
});

export type Interaction = typeof InteractionSchema.Type;
