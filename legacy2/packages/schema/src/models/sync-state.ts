import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { SyncTargetSchema } from "../enums";
import { SyncStateIdSchema, WorkspaceIdSchema } from "../ids";

export const SyncStateSchema = Schema.Struct({
  id: SyncStateIdSchema,
  workspaceId: WorkspaceIdSchema,
  target: SyncTargetSchema,
  targetUrl: Schema.String,
  linkedSubject: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  lastSyncAt: Schema.NullOr(TimestampMsSchema),
  updatedAt: TimestampMsSchema,
});

export type SyncState = typeof SyncStateSchema.Type;
