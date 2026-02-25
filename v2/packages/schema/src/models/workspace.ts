import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { ProfileIdSchema, WorkspaceIdSchema } from "../ids";

export const WorkspaceSchema = Schema.Struct({
  id: WorkspaceIdSchema,
  profileId: ProfileIdSchema,
  name: Schema.String,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type Workspace = typeof WorkspaceSchema.Type;
