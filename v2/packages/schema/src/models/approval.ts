import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { ApprovalStatusSchema } from "../enums";
import { ApprovalIdSchema, TaskRunIdSchema, WorkspaceIdSchema } from "../ids";

export const ApprovalSchema = Schema.Struct({
  id: ApprovalIdSchema,
  workspaceId: WorkspaceIdSchema,
  taskRunId: TaskRunIdSchema,
  toolPath: Schema.String,
  status: ApprovalStatusSchema,
  inputPreviewJson: Schema.String,
  reason: Schema.NullOr(Schema.String),
  requestedAt: TimestampMsSchema,
  resolvedAt: Schema.NullOr(TimestampMsSchema),
});

export type Approval = typeof ApprovalSchema.Type;
