import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  InteractionActionSchema,
  InteractionModeSchema,
  InteractionStatusSchema,
} from "../enums";
import { InteractionIdSchema, TaskRunIdSchema, WorkspaceIdSchema } from "../ids";

export const InteractionSchema = Schema.Struct({
  id: InteractionIdSchema,
  workspaceId: WorkspaceIdSchema,
  taskRunId: TaskRunIdSchema,
  originServer: Schema.String,
  originRequestId: Schema.String,
  callId: Schema.String,
  toolPath: Schema.String,
  mode: InteractionModeSchema,
  elicitationId: Schema.NullOr(Schema.String),
  message: Schema.String,
  requestedSchemaJson: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  status: InteractionStatusSchema,
  requestJson: Schema.String,
  responseAction: Schema.NullOr(InteractionActionSchema),
  responseContentJson: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  requestedAt: TimestampMsSchema,
  resolvedAt: Schema.NullOr(TimestampMsSchema),
  completionNotifiedAt: Schema.NullOr(TimestampMsSchema),
  expiresAt: Schema.NullOr(TimestampMsSchema),
});

export type Interaction = typeof InteractionSchema.Type;
