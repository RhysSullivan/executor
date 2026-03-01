import { Schema } from "effect";

export const AccountIdSchema = Schema.String.pipe(Schema.brand("AccountId"));
export const OrganizationIdSchema = Schema.String.pipe(Schema.brand("OrganizationId"));
export const ProfileIdSchema = Schema.String.pipe(Schema.brand("ProfileId"));
export const WorkspaceIdSchema = Schema.String.pipe(Schema.brand("WorkspaceId"));
export const SourceIdSchema = Schema.String.pipe(Schema.brand("SourceId"));
export const ToolArtifactIdSchema = Schema.String.pipe(Schema.brand("ToolArtifactId"));
export const CredentialBindingIdSchema = Schema.String.pipe(
  Schema.brand("CredentialBindingId"),
);
export const CredentialIdSchema = Schema.String.pipe(Schema.brand("CredentialId"));
export const OAuthTokenIdSchema = Schema.String.pipe(Schema.brand("OAuthTokenId"));
export const OrganizationMemberIdSchema = Schema.String.pipe(
  Schema.brand("OrganizationMemberId"),
);
export const PolicyIdSchema = Schema.String.pipe(Schema.brand("PolicyId"));
export const ApprovalIdSchema = Schema.String.pipe(Schema.brand("ApprovalId"));
export const TaskRunIdSchema = Schema.String.pipe(Schema.brand("TaskRunId"));
export const SyncStateIdSchema = Schema.String.pipe(Schema.brand("SyncStateId"));
export const EventIdSchema = Schema.String.pipe(Schema.brand("EventId"));

export type AccountId = typeof AccountIdSchema.Type;
export type OrganizationId = typeof OrganizationIdSchema.Type;
export type ProfileId = typeof ProfileIdSchema.Type;
export type WorkspaceId = typeof WorkspaceIdSchema.Type;
export type SourceId = typeof SourceIdSchema.Type;
export type ToolArtifactId = typeof ToolArtifactIdSchema.Type;
export type CredentialBindingId = typeof CredentialBindingIdSchema.Type;
export type CredentialId = typeof CredentialIdSchema.Type;
export type OAuthTokenId = typeof OAuthTokenIdSchema.Type;
export type OrganizationMemberId = typeof OrganizationMemberIdSchema.Type;
export type PolicyId = typeof PolicyIdSchema.Type;
export type ApprovalId = typeof ApprovalIdSchema.Type;
export type TaskRunId = typeof TaskRunIdSchema.Type;
export type SyncStateId = typeof SyncStateIdSchema.Type;
export type EventId = typeof EventIdSchema.Type;
