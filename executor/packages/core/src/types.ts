// ── Shared types (inlined from @executor/contracts) ──────────────────────────

import type { Id } from "../../database/convex/_generated/dataModel.d.ts";

export const ACCOUNT_PROVIDERS = ["workos", "anonymous"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export const ACCOUNT_STATUSES = ["active", "deleted"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ORGANIZATION_STATUSES = ["active", "deleted"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const ORGANIZATION_ROLES = ["owner", "admin", "member", "billing_admin"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ORGANIZATION_MEMBER_STATUSES = ["active", "pending", "removed"] as const;
export type OrganizationMemberStatus = (typeof ORGANIZATION_MEMBER_STATUSES)[number];

export const BILLING_SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;
export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];

export const INVITE_STATUSES = ["pending", "accepted", "expired", "revoked", "failed"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const TASK_STATUSES = ["queued", "running", "completed", "failed", "timed_out", "denied"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const COMPLETED_TASK_STATUSES = ["completed", "failed", "timed_out", "denied"] as const;
export type CompletedTaskStatus = (typeof COMPLETED_TASK_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "denied"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TOOL_CALL_STATUSES = ["requested", "pending_approval", "completed", "failed", "denied"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const TERMINAL_TOOL_CALL_STATUSES = ["completed", "failed", "denied"] as const;
export type TerminalToolCallStatus = (typeof TERMINAL_TOOL_CALL_STATUSES)[number];

export type PolicyDecision = "allow" | "require_approval" | "deny";

export const POLICY_SCOPE_TYPES = ["account", "organization", "workspace"] as const;
export type PolicyScopeType = (typeof POLICY_SCOPE_TYPES)[number];

export const POLICY_MATCH_TYPES = ["glob", "exact"] as const;
export type PolicyMatchType = (typeof POLICY_MATCH_TYPES)[number];

export const POLICY_EFFECTS = ["allow", "deny"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export const POLICY_APPROVAL_MODES = ["inherit", "auto", "required"] as const;
export type PolicyApprovalMode = (typeof POLICY_APPROVAL_MODES)[number];

export const POLICY_RESOURCE_TYPES = ["all_tools", "source", "namespace", "tool_path"] as const;
export type PolicyResourceType = (typeof POLICY_RESOURCE_TYPES)[number];

export const TOOL_SOURCE_SCOPE_TYPES = ["organization", "workspace"] as const;
export type ToolSourceScopeType = (typeof TOOL_SOURCE_SCOPE_TYPES)[number];

export const CREDENTIAL_SCOPE_TYPES = ["account", "organization", "workspace"] as const;
export type CredentialScopeType = (typeof CREDENTIAL_SCOPE_TYPES)[number];
export type CredentialScope = CredentialScopeType;

export const CREDENTIAL_PROVIDERS = ["local-convex", "workos-vault"] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

export const TOOL_APPROVAL_MODES = ["auto", "required"] as const;
export type ToolApprovalMode = (typeof TOOL_APPROVAL_MODES)[number];

export const TOOL_SOURCE_TYPES = ["mcp", "openapi", "graphql"] as const;
export type ToolSourceType = (typeof TOOL_SOURCE_TYPES)[number];

export const STORAGE_SCOPE_TYPES = ["scratch", "account", "workspace", "organization"] as const;
export type StorageScopeType = (typeof STORAGE_SCOPE_TYPES)[number];

export const STORAGE_DURABILITIES = ["ephemeral", "durable"] as const;
export type StorageDurability = (typeof STORAGE_DURABILITIES)[number];

export const STORAGE_INSTANCE_STATUSES = ["active", "closed", "deleted"] as const;
export type StorageInstanceStatus = (typeof STORAGE_INSTANCE_STATUSES)[number];

export const STORAGE_PROVIDERS = ["agentfs-local", "agentfs-cloudflare"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const STORAGE_ACCESS_TYPES = ["opened", "provided", "accessed"] as const;
export type StorageAccessType = (typeof STORAGE_ACCESS_TYPES)[number];

export type JsonSchema = Record<string, unknown>;

export const SOURCE_AUTH_TYPES = ["none", "bearer", "apiKey", "basic", "mixed"] as const;
export type SourceAuthType = (typeof SOURCE_AUTH_TYPES)[number];

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
  workspaceId: Id<"workspaces">;
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

export interface TaskExecutionOutcome {
  task: TaskRecord;
  result?: unknown;
  durationMs?: number;
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

export interface ToolCallRecord {
  taskId: string;
  callId: string;
  workspaceId: Id<"workspaces">;
  toolPath: string;
  status: ToolCallStatus;
  approvalId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export const ARGUMENT_CONDITION_OPERATORS = ["equals", "contains", "starts_with", "not_equals"] as const;
export type ArgumentConditionOperator = (typeof ARGUMENT_CONDITION_OPERATORS)[number];

export interface ArgumentCondition {
  key: string;
  operator: ArgumentConditionOperator;
  value: string;
}

export interface ToolPolicyRecord {
  id: string;
  scopeType: PolicyScopeType;
  organizationId: Id<"organizations">;
  workspaceId?: Id<"workspaces">;
  targetAccountId?: Id<"accounts">;
  clientId?: string;
  resourceType: PolicyResourceType;
  resourcePattern: string;
  matchType: PolicyMatchType;
  effect: PolicyEffect;
  approvalMode: PolicyApprovalMode;
  argumentConditions?: ArgumentCondition[];
  priority: number;
  roleId?: string;
  ruleId?: string;
  bindingId?: string;
  createdAt: number;
  updatedAt: number;
}

export const TOOL_ROLE_SELECTOR_TYPES = ["all", "source", "namespace", "tool_path"] as const;
export type ToolRoleSelectorType = (typeof TOOL_ROLE_SELECTOR_TYPES)[number];

export const TOOL_ROLE_BINDING_STATUSES = ["active", "disabled"] as const;
export type ToolRoleBindingStatus = (typeof TOOL_ROLE_BINDING_STATUSES)[number];

export interface ToolPolicySetRecord {
  id: string;
  organizationId: Id<"organizations">;
  name: string;
  description?: string;
  createdByAccountId?: Id<"accounts">;
  createdAt: number;
  updatedAt: number;
}

export interface ToolPolicyRuleRecord {
  id: string;
  roleId: string;
  organizationId: Id<"organizations">;
  selectorType: ToolRoleSelectorType;
  sourceKey?: string;
  namespacePattern?: string;
  toolPathPattern?: string;
  matchType: PolicyMatchType;
  effect: PolicyEffect;
  approvalMode: PolicyApprovalMode;
  argumentConditions?: ArgumentCondition[];
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface ToolPolicyAssignmentRecord {
  id: string;
  roleId: string;
  organizationId: Id<"organizations">;
  scopeType: PolicyScopeType;
  workspaceId?: Id<"workspaces">;
  targetAccountId?: Id<"accounts">;
  clientId?: string;
  status: ToolRoleBindingStatus;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialRecord {
  id: string;
  bindingId?: string;
  scopeType: CredentialScopeType;
  accountId?: Id<"accounts">;
  organizationId: Id<"organizations">;
  workspaceId?: Id<"workspaces">;
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
  organizationId?: Id<"organizations">;
  workspaceId?: Id<"workspaces">;
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
  organizationId: Id<"organizations">;
  workspaceId?: Id<"workspaces">;
  accountId?: Id<"accounts">;
  createdByAccountId?: Id<"accounts">;
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
  /** Canonical tool typing/signature info for clients (schema-less Convex-safe subset). */
  typing?: ToolDescriptorTyping;
  /** Lightweight, human-readable signature hints (derived from schema/typed refs). */
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

// ── Server-only types ─────────────────────────────────────────────────────────

export interface CreateTaskInput {
  code: string;
  timeoutMs?: number;
  runtimeId?: string;
  metadata?: Record<string, unknown>;
  workspaceId: Id<"workspaces">;
  accountId: Id<"accounts">;
  clientId?: string;
}

export interface SandboxExecutionRequest {
  taskId: string;
  code: string;
  timeoutMs: number;
}

export interface SandboxExecutionResult {
  status: Extract<TaskStatus, "completed" | "failed" | "timed_out" | "denied">;
  result?: unknown;
  exitCode?: number;
  error?: string;
  durationMs: number;
}

export interface ToolCallRequest {
  runId: string;
  callId: string;
  toolPath: string;
  input: unknown;
}

export type ToolCallResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      kind: "pending";
      approvalId: string;
      retryAfterMs?: number;
      error?: string;
    }
  | { ok: false; kind: "denied"; error: string }
  | { ok: false; kind: "failed"; error: string };

export interface ExecutionAdapter {
  invokeTool(call: ToolCallRequest): Promise<ToolCallResult>;
}

export interface SandboxRuntime {
  id: string;
  label: string;
  description: string;
  run(
    request: SandboxExecutionRequest,
    adapter: ExecutionAdapter,
  ): Promise<SandboxExecutionResult>;
}

export const TOOL_CREDENTIAL_AUTH_TYPES = ["bearer", "apiKey", "basic"] as const;
export type ToolCredentialAuthType = (typeof TOOL_CREDENTIAL_AUTH_TYPES)[number];

export interface ToolCredentialSpec {
  sourceKey: string;
  mode: CredentialScope;
  authType: ToolCredentialAuthType;
  headerName?: string;
  staticSecretJson?: Record<string, unknown>;
}

export interface ResolvedToolCredential {
  sourceKey: string;
  mode: CredentialScope;
  headers: Record<string, string>;
}

export interface ToolRunContext {
  taskId: string;
  workspaceId: Id<"workspaces">;
  accountId?: Id<"accounts">;
  clientId?: string;
  credential?: ResolvedToolCredential;
  isToolAllowed: (toolPath: string) => boolean;
}

export type ToolTypedRef =
  | {
      kind: "openapi_operation";
      /** Source key (e.g. "openapi:github") used for namespacing in type bundles. */
      sourceKey: string;
      /** OperationId in the OpenAPI spec (key for `operations[...]`). */
      operationId: string;
    };

export interface ToolTyping {
  /** JSON Schema describing the tool input payload. */
  inputSchema?: JsonSchema;
  /** JSON Schema describing the tool output payload. */
  outputSchema?: JsonSchema;
  /**
   * Optional human-readable type hints derived from schema/OpenAPI.
   * Used for discover/catalog outputs and UI signatures.
   */
  inputHint?: string;
  outputHint?: string;
  /** Required top-level keys for quick validation and examples. */
  requiredInputKeys?: string[];
  /** Preview keys for UI/examples (required keys first, then common keys). */
  previewInputKeys?: string[];
  /** Optional referenced OpenAPI component keys for source-level ref hint lookup. */
  refHintKeys?: string[];
  /** Optional high-fidelity typed reference for sources with native type maps (e.g. OpenAPI). */
  typedRef?: ToolTypedRef;
}

/**
 * Convex cannot serialize objects with `$`-prefixed keys.
 * Keep ToolDescriptor typing limited to Convex-safe scalar/array fields.
 */
export interface ToolDescriptorTyping {
  requiredInputKeys?: string[];
  previewInputKeys?: string[];
  refHintKeys?: string[];
  refHints?: Record<string, string>;
  /** Convex-safe JSON-encoded input schema for UI/detail rendering. */
  inputSchemaJson?: string;
  /** Convex-safe JSON-encoded output schema for UI/detail rendering. */
  outputSchemaJson?: string;
  typedRef?: ToolTypedRef;
}

export interface ToolDefinition {
  path: string;
  description: string;
  approval: ToolApprovalMode;
  source?: string;
  typing?: ToolTyping;
  credential?: ToolCredentialSpec;
  /** For GraphQL sources: the source name used for dynamic path extraction */
  _graphqlSource?: string;
  /** For GraphQL pseudo-tools: marks tools that exist only for discovery/policy */
  _pseudoTool?: boolean;
  /** Serializable data to reconstruct `run` from cache. Attached during tool building. */
  _runSpec?: unknown;
  run(input: unknown, context: ToolRunContext): Promise<unknown>;
}
