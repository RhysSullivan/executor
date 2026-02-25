import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { TaskRunStatusSchema } from "../enums";
import { TaskRunIdSchema, WorkspaceIdSchema } from "../ids";

export const TaskRunSchema = Schema.Struct({
  id: TaskRunIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: Schema.String,
  runtimeId: Schema.String,
  codeHash: Schema.String,
  status: TaskRunStatusSchema,
  startedAt: Schema.NullOr(TimestampMsSchema),
  completedAt: Schema.NullOr(TimestampMsSchema),
  exitCode: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});

export type TaskRun = typeof TaskRunSchema.Type;
