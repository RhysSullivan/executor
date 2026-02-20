import type { Id } from "@executor/database/convex/_generated/dataModel";
import type {
  ApprovalStatus as CoreApprovalStatus,
  ArgumentConditionOperator as CoreArgumentConditionOperator,
  CredentialProvider as CoreCredentialProvider,
  CredentialScope as CoreCredentialScope,
  CredentialScopeType as CoreCredentialScopeType,
  PolicyApprovalMode as CorePolicyApprovalMode,
  PolicyDecision as CorePolicyDecision,
  PolicyEffect as CorePolicyEffect,
  PolicyMatchType as CorePolicyMatchType,
  PolicyScopeType as CorePolicyScopeType,
  SourceAuthType as CoreSourceAuthType,
  StorageDurability as CoreStorageDurability,
  StorageInstanceStatus as CoreStorageInstanceStatus,
  StorageProvider as CoreStorageProvider,
  StorageScopeType as CoreStorageScopeType,
  TaskStatus as CoreTaskStatus,
  ToolApprovalMode as CoreToolApprovalMode,
  ToolRoleBindingStatus as CoreToolRoleBindingStatus,
  ToolRoleSelectorType as CoreToolRoleSelectorType,
  ToolSourceScopeType as CoreToolSourceScopeType,
  ToolSourceType as CoreToolSourceType,
  ToolPolicyRecord as CoreToolPolicyRecord,
  ToolPolicyAssignmentRecord as CoreToolPolicyAssignmentRecord,
  ToolPolicySetRecord as CoreToolPolicySetRecord,
  ToolPolicyRuleRecord as CoreToolPolicyRuleRecord,
} from "@executor/core/types";

// ── Shared types (inlined from @executor/contracts) ──────────────────────────

export type TaskStatus = CoreTaskStatus;
export type ApprovalStatus = CoreApprovalStatus;
export type PolicyDecision = CorePolicyDecision;
export type PolicyScopeType = CorePolicyScopeType;
export type PolicyMatchType = CorePolicyMatchType;
export type PolicyEffect = CorePolicyEffect;
export type PolicyApprovalMode = CorePolicyApprovalMode;
export type ToolRoleSelectorType = CoreToolRoleSelectorType;
export type ToolRoleBindingStatus = CoreToolRoleBindingStatus;
export type ArgumentConditionOperator = CoreArgumentConditionOperator;

export interface ArgumentCondition {
  key: string;
  operator: ArgumentConditionOperator;
  value: string;
}
export type CredentialScope = CoreCredentialScope;
export type CredentialProvider = CoreCredentialProvider;
export type ToolSourceScopeType = CoreToolSourceScopeType;
export type CredentialScopeType = CoreCredentialScopeType;
export type ToolApprovalMode = CoreToolApprovalMode;
export type ToolSourceType = CoreToolSourceType;
export type StorageScopeType = CoreStorageScopeType;
export type StorageDurability = CoreStorageDurability;
export type StorageInstanceStatus = CoreStorageInstanceStatus;
export type StorageProvider = CoreStorageProvider;

export type SourceAuthType = CoreSourceAuthType;

export interface SourceAuthProfile {
  type: SourceAuthType;
  mode?: CredentialScope;
  header?: string;
  inferred: boolean;
}

export interface TaskRecord {
  id: string;
  code: string;
  runtimeId: string;
  status: TaskStatus;
  timeoutMs: number;
  metadata: Record<string, unknown>;
  workspaceId: string;
  accountId?: Id<"accounts">;
  clientId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  exitCode?: number;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  toolPath: string;
  input: unknown;
  status: ApprovalStatus;
  reason?: string;
  reviewerId?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface PendingApprovalRecord extends ApprovalRecord {
  task: Pick<TaskRecord, "id" | "status" | "runtimeId" | "timeoutMs" | "createdAt">;
}

export interface TaskEventRecord {
  id: number;
  taskId: string;
  eventName: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

export type ToolPolicyRecord = CoreToolPolicyRecord;
export type ToolPolicySetRecord = CoreToolPolicySetRecord;
export type ToolPolicyRuleRecord = CoreToolPolicyRuleRecord;
export type ToolPolicyAssignmentRecord = CoreToolPolicyAssignmentRecord;

export interface CredentialRecord {
  id: string;
  bindingId?: string;
  scopeType: CredentialScopeType;
  accountId?: Id<"accounts">;
  organizationId?: string;
  workspaceId?: string;
  sourceKey: string;
  overridesJson?: Record<string, unknown>;
  boundAuthFingerprint?: string;
  provider: CredentialProvider;
  secretJson: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ToolSourceRecord {
  id: string;
  scopeType: ToolSourceScopeType;
  organizationId?: string;
  workspaceId?: string;
  name: string;
  type: ToolSourceType;
  configVersion: number;
  config: Record<string, unknown>;
  specHash?: string;
  authFingerprint?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StorageInstanceRecord {
  id: string;
  scopeType: StorageScopeType;
  durability: StorageDurability;
  status: StorageInstanceStatus;
  provider: StorageProvider;
  backendKey: string;
  organizationId: string;
  workspaceId?: string;
  accountId?: string;
  createdByAccountId?: string;
  purpose?: string;
  sizeBytes?: number;
  fileCount?: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  closedAt?: number;
  expiresAt?: number;
}

export interface ToolDescriptor {
  path: string;
  description: string;
  approval: ToolApprovalMode;
  source?: string;
  typing?: {
    requiredInputKeys?: string[];
    previewInputKeys?: string[];
    refHintKeys?: string[];
    refHints?: Record<string, string>;
    inputSchemaJson?: string;
    outputSchemaJson?: string;
    typedRef?: {
      kind: "openapi_operation";
      sourceKey: string;
      operationId: string;
    };
  };
  display?: {
    input?: string;
    output?: string;
  };
}

export interface OpenApiSourceQuality {
  sourceKey: string;
  toolCount: number;
  unknownArgsCount: number;
  unknownReturnsCount: number;
  partialUnknownArgsCount: number;
  partialUnknownReturnsCount: number;
  argsQuality: number;
  returnsQuality: number;
  overallQuality: number;
}

export interface AnonymousContext {
  sessionId: string;
  workspaceId: Id<"workspaces">;
  clientId: string;
  accountId: Id<"accounts">;
  createdAt: number;
  lastSeenAt: number;
}

// ── Web-only types ────────────────────────────────────────────────────────────

export type ApprovalDecision = "approved" | "denied";

export interface CreateTaskRequest {
  code: string;
  runtimeId?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  workspaceId: string;
  accountId: string;
  clientId?: string;
}

export interface CreateTaskResponse {
  taskId: string;
  status: TaskStatus;
}

export interface ResolveApprovalRequest {
  workspaceId: string;
  decision: ApprovalDecision;
  reviewerId?: string;
  reason?: string;
}

export interface RuntimeTargetDescriptor {
  id: string;
  label: string;
  description: string;
}

export interface CredentialDescriptor {
  id: string;
  workspaceId: string;
  sourceKey: string;
  scope: CredentialScopeType;
  hasSecret: boolean;
}
