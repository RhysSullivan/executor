import { Schema } from "effect";

import { SchemaVersionSchema, TimestampMsSchema } from "./common";
import { EventEnvelopeSchema } from "./models/event-envelope";
import { ApprovalSchema } from "./models/approval";
import { CredentialRefSchema } from "./models/credential-ref";
import { OAuthTokenSchema } from "./models/oauth-token";
import { PolicySchema } from "./models/policy";
import { ProfileSchema } from "./models/profile";
import { SourceSchema } from "./models/source";
import { SyncStateSchema } from "./models/sync-state";
import { TaskRunSchema } from "./models/task-run";
import { ToolArtifactSchema } from "./models/tool-artifact";
import { WorkspaceSchema } from "./models/workspace";

export const StateSnapshotSchema = Schema.Struct({
  schemaVersion: SchemaVersionSchema,
  generatedAt: TimestampMsSchema,
  profile: ProfileSchema,
  workspaces: Schema.Array(WorkspaceSchema),
  sources: Schema.Array(SourceSchema),
  toolArtifacts: Schema.Array(ToolArtifactSchema),
  credentials: Schema.Array(CredentialRefSchema),
  oauthTokens: Schema.Array(OAuthTokenSchema),
  policies: Schema.Array(PolicySchema),
  approvals: Schema.Array(ApprovalSchema),
  taskRuns: Schema.Array(TaskRunSchema),
  syncStates: Schema.Array(SyncStateSchema),
});

export const StateEventLogSchema = Schema.Array(EventEnvelopeSchema);

export type StateSnapshot = typeof StateSnapshotSchema.Type;
export type StateEventLog = typeof StateEventLogSchema.Type;
