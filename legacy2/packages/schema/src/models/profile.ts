import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { RuntimeModeSchema } from "../enums";
import { ProfileIdSchema, WorkspaceIdSchema } from "../ids";

export const ProfileSchema = Schema.Struct({
  id: ProfileIdSchema,
  defaultWorkspaceId: Schema.NullOr(WorkspaceIdSchema),
  displayName: Schema.String,
  runtimeMode: RuntimeModeSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type Profile = typeof ProfileSchema.Type;
