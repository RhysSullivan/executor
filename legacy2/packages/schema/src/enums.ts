import { Schema } from "effect";

export const RuntimeModeSchema = Schema.Literal("local", "linked", "remote");
export const SourceKindSchema = Schema.Literal("mcp", "openapi", "graphql", "internal");
export const SourceStatusSchema = Schema.Literal("draft", "probing", "auth_required", "connected", "error");
export const PolicyDecisionSchema = Schema.Literal("allow", "require_approval", "deny");
export const InteractionModeSchema = Schema.Literal("form", "url");
export const InteractionActionSchema = Schema.Literal("accept", "decline", "cancel");
export const InteractionStatusSchema = Schema.Literal(
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
  "failed",
);
export const TaskRunStatusSchema = Schema.Literal(
  "queued",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "timed_out",
  "denied",
);
export const CredentialModeSchema = Schema.Literal("none", "api_key", "bearer", "oauth2", "custom");
export const CredentialProviderSchema = Schema.Literal(
  "api_key",
  "bearer",
  "oauth2",
  "basic",
  "custom",
);
export const CredentialScopeTypeSchema = Schema.Literal(
  "workspace",
  "organization",
  "account",
);
export const AuthConnectionStrategySchema = Schema.Literal(
  "oauth2",
  "api_key",
  "bearer",
  "basic",
  "custom",
);
export const AuthConnectionStatusSchema = Schema.Literal(
  "active",
  "reauth_required",
  "revoked",
  "disabled",
  "error",
);
export const AuthOwnerTypeSchema = Schema.Literal(
  "organization",
  "workspace",
  "account",
);
export const AuthBindingScopeTypeSchema = Schema.Literal(
  "workspace",
  "organization",
  "account",
);
export const OAuthStateStatusSchema = Schema.Literal(
  "valid",
  "expiring",
  "refreshing",
  "reauth_required",
  "revoked",
);
export const AuthAuditEventTypeSchema = Schema.Literal(
  "created",
  "updated",
  "bound",
  "unbound",
  "refresh_success",
  "refresh_failed",
  "reauth_required",
  "revoked",
  "deleted",
);
export const AuthActorTypeSchema = Schema.Literal("system", "account");
export const StorageScopeTypeSchema = Schema.Literal(
  "scratch",
  "account",
  "workspace",
  "organization",
);
export const StorageDurabilitySchema = Schema.Literal("ephemeral", "durable");
export const StorageInstanceStatusSchema = Schema.Literal("active", "closed", "deleted");
export const StorageProviderSchema = Schema.Literal("agentfs-local", "agentfs-cloudflare");
export const OrganizationStatusSchema = Schema.Literal("active", "suspended", "archived");
export const OrganizationMemberStatusSchema = Schema.Literal(
  "invited",
  "active",
  "suspended",
  "removed",
);
export const SyncTargetSchema = Schema.Literal("remote");

export type RuntimeMode = typeof RuntimeModeSchema.Type;
export type SourceKind = typeof SourceKindSchema.Type;
export type SourceStatus = typeof SourceStatusSchema.Type;
export type PolicyDecision = typeof PolicyDecisionSchema.Type;
export type InteractionMode = typeof InteractionModeSchema.Type;
export type InteractionAction = typeof InteractionActionSchema.Type;
export type InteractionStatus = typeof InteractionStatusSchema.Type;
export type TaskRunStatus = typeof TaskRunStatusSchema.Type;
export type CredentialMode = typeof CredentialModeSchema.Type;
export type CredentialProvider = typeof CredentialProviderSchema.Type;
export type CredentialScopeType = typeof CredentialScopeTypeSchema.Type;
export type AuthConnectionStrategy = typeof AuthConnectionStrategySchema.Type;
export type AuthConnectionStatus = typeof AuthConnectionStatusSchema.Type;
export type AuthOwnerType = typeof AuthOwnerTypeSchema.Type;
export type AuthBindingScopeType = typeof AuthBindingScopeTypeSchema.Type;
export type OAuthStateStatus = typeof OAuthStateStatusSchema.Type;
export type AuthAuditEventType = typeof AuthAuditEventTypeSchema.Type;
export type AuthActorType = typeof AuthActorTypeSchema.Type;
export type StorageScopeType = typeof StorageScopeTypeSchema.Type;
export type StorageDurability = typeof StorageDurabilitySchema.Type;
export type StorageInstanceStatus = typeof StorageInstanceStatusSchema.Type;
export type StorageProvider = typeof StorageProviderSchema.Type;
export type OrganizationStatus = typeof OrganizationStatusSchema.Type;
export type OrganizationMemberStatus = typeof OrganizationMemberStatusSchema.Type;
export type SyncTarget = typeof SyncTargetSchema.Type;
