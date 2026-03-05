import { Schema } from "effect";

export const AccountIdSchema = Schema.String.pipe(Schema.brand("AccountId"));
export const OrganizationIdSchema = Schema.String.pipe(Schema.brand("OrganizationId"));
export const ProfileIdSchema = Schema.String.pipe(Schema.brand("ProfileId"));
export const WorkspaceIdSchema = Schema.String.pipe(Schema.brand("WorkspaceId"));
export const SourceIdSchema = Schema.String.pipe(Schema.brand("SourceId"));
export const ToolArtifactIdSchema = Schema.String.pipe(Schema.brand("ToolArtifactId"));
export const AuthConnectionIdSchema = Schema.String.pipe(
  Schema.brand("AuthConnectionId"),
);
export const SourceAuthBindingIdSchema = Schema.String.pipe(
  Schema.brand("SourceAuthBindingId"),
);
export const AuthMaterialIdSchema = Schema.String.pipe(
  Schema.brand("AuthMaterialId"),
);
export const OAuthStateIdSchema = Schema.String.pipe(Schema.brand("OAuthStateId"));
export const AuthAuditEventIdSchema = Schema.String.pipe(
  Schema.brand("AuthAuditEventId"),
);
export const OrganizationMemberIdSchema = Schema.String.pipe(
  Schema.brand("OrganizationMemberId"),
);
export const PolicyIdSchema = Schema.String.pipe(Schema.brand("PolicyId"));
export const InteractionIdSchema = Schema.String.pipe(Schema.brand("InteractionId"));
export const TaskRunIdSchema = Schema.String.pipe(Schema.brand("TaskRunId"));
export const SyncStateIdSchema = Schema.String.pipe(Schema.brand("SyncStateId"));
export const StorageInstanceIdSchema = Schema.String.pipe(
  Schema.brand("StorageInstanceId"),
);
export const EventIdSchema = Schema.String.pipe(Schema.brand("EventId"));

export type AccountId = typeof AccountIdSchema.Type;
export type OrganizationId = typeof OrganizationIdSchema.Type;
export type ProfileId = typeof ProfileIdSchema.Type;
export type WorkspaceId = typeof WorkspaceIdSchema.Type;
export type SourceId = typeof SourceIdSchema.Type;
export type ToolArtifactId = typeof ToolArtifactIdSchema.Type;
export type AuthConnectionId = typeof AuthConnectionIdSchema.Type;
export type SourceAuthBindingId = typeof SourceAuthBindingIdSchema.Type;
export type AuthMaterialId = typeof AuthMaterialIdSchema.Type;
export type OAuthStateId = typeof OAuthStateIdSchema.Type;
export type AuthAuditEventId = typeof AuthAuditEventIdSchema.Type;
export type OrganizationMemberId = typeof OrganizationMemberIdSchema.Type;
export type PolicyId = typeof PolicyIdSchema.Type;
export type InteractionId = typeof InteractionIdSchema.Type;
export type TaskRunId = typeof TaskRunIdSchema.Type;
export type SyncStateId = typeof SyncStateIdSchema.Type;
export type StorageInstanceId = typeof StorageInstanceIdSchema.Type;
export type EventId = typeof EventIdSchema.Type;
