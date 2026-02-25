import { Schema } from "effect";

export const RuntimeModeSchema = Schema.Literal("local", "linked", "remote");
export const SourceKindSchema = Schema.Literal("mcp", "openapi", "graphql", "internal");
export const SourceStatusSchema = Schema.Literal("draft", "probing", "auth_required", "connected", "error");
export const PolicyDecisionSchema = Schema.Literal("allow", "require_approval", "deny");
export const ApprovalStatusSchema = Schema.Literal("pending", "approved", "denied", "expired");
export const TaskRunStatusSchema = Schema.Literal("queued", "running", "completed", "failed", "timed_out", "denied");
export const CredentialModeSchema = Schema.Literal("none", "api_key", "bearer", "oauth2", "custom");
export const SyncTargetSchema = Schema.Literal("remote");

export type RuntimeMode = typeof RuntimeModeSchema.Type;
export type SourceKind = typeof SourceKindSchema.Type;
export type SourceStatus = typeof SourceStatusSchema.Type;
export type PolicyDecision = typeof PolicyDecisionSchema.Type;
export type ApprovalStatus = typeof ApprovalStatusSchema.Type;
export type TaskRunStatus = typeof TaskRunStatusSchema.Type;
export type CredentialMode = typeof CredentialModeSchema.Type;
export type SyncTarget = typeof SyncTargetSchema.Type;
