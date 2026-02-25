import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { PolicyDecisionSchema } from "../enums";
import { PolicyIdSchema, WorkspaceIdSchema } from "../ids";

export const PolicySchema = Schema.Struct({
  id: PolicyIdSchema,
  workspaceId: WorkspaceIdSchema,
  toolPathPattern: Schema.String,
  decision: PolicyDecisionSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type Policy = typeof PolicySchema.Type;
