import { Id } from "@executor-v2/confect";

export const ProfileDocIdSchema = Id("profiles");
export const WorkspaceDocIdSchema = Id("workspaces");
export const SourceDocIdSchema = Id("sources");
export const ToolArtifactDocIdSchema = Id("toolArtifacts");
export const CredentialRefDocIdSchema = Id("credentialRefs");
export const OAuthTokenDocIdSchema = Id("oauthTokens");
export const PolicyDocIdSchema = Id("policies");
export const ApprovalDocIdSchema = Id("approvals");
export const TaskRunDocIdSchema = Id("taskRuns");
export const SyncStateDocIdSchema = Id("syncStates");
export const EventDocIdSchema = Id("events");

export type ProfileDocId = typeof ProfileDocIdSchema.Type;
export type WorkspaceDocId = typeof WorkspaceDocIdSchema.Type;
export type SourceDocId = typeof SourceDocIdSchema.Type;
export type ToolArtifactDocId = typeof ToolArtifactDocIdSchema.Type;
export type CredentialRefDocId = typeof CredentialRefDocIdSchema.Type;
export type OAuthTokenDocId = typeof OAuthTokenDocIdSchema.Type;
export type PolicyDocId = typeof PolicyDocIdSchema.Type;
export type ApprovalDocId = typeof ApprovalDocIdSchema.Type;
export type TaskRunDocId = typeof TaskRunDocIdSchema.Type;
export type SyncStateDocId = typeof SyncStateDocIdSchema.Type;
export type EventDocId = typeof EventDocIdSchema.Type;
