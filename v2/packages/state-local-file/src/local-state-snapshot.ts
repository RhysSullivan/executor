import {
  ApprovalSchema,
  CredentialRefSchema,
  EventEnvelopeSchema,
  OAuthTokenSchema,
  PolicySchema,
  ProfileSchema,
  SchemaVersionSchema,
  SourceSchema,
  SyncStateSchema,
  TaskRunSchema,
  TimestampMsSchema,
  ToolArtifactSchema,
  WorkspaceSchema,
} from "@executor-v2/schema";
import { Schema } from "effect";

export const LocalStateSnapshotSchema = Schema.Struct({
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

export const LocalStateEventLogSchema = Schema.Array(EventEnvelopeSchema);

export type LocalStateSnapshot = typeof LocalStateSnapshotSchema.Type;
export type LocalStateEventLog = typeof LocalStateEventLogSchema.Type;
