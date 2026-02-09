// ── Status enums ──────────────────────────────────────────────────────────────

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "denied";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type PolicyDecision = "allow" | "require_approval" | "deny";

export type CredentialScope = "workspace" | "actor";

export type CredentialProvider = "managed" | "workos-vault";

export type ToolApprovalMode = "auto" | "required";

export type ToolSourceType = "mcp" | "openapi" | "graphql";

// ── Records ───────────────────────────────────────────────────────────────────

export interface TaskRecord {
  id: string;
  code: string;
  runtimeId: string;
  status: TaskStatus;
  timeoutMs: number;
  metadata: Record<string, unknown>;
  workspaceId: string;
  actorId?: string;
  clientId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  stdout?: string;
  stderr?: string;
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

export interface AccessPolicyRecord {
  id: string;
  workspaceId: string;
  actorId?: string;
  clientId?: string;
  toolPathPattern: string;
  decision: PolicyDecision;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialRecord {
  id: string;
  workspaceId: string;
  sourceKey: string;
  scope: CredentialScope;
  actorId?: string;
  provider: CredentialProvider;
  secretJson: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ToolSourceRecord {
  id: string;
  workspaceId: string;
  name: string;
  type: ToolSourceType;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Descriptors ───────────────────────────────────────────────────────────────

export interface ToolDescriptor {
  path: string;
  description: string;
  approval: ToolApprovalMode;
  source?: string;
  /** Lightweight TS type hint for args (for LLM prompt / discover tool). */
  argsType?: string;
  /** Lightweight TS type hint for return value (for LLM prompt / discover tool). */
  returnsType?: string;
  /** Raw operationId from the OpenAPI spec (used by Monaco for indexed access types). */
  operationId?: string;
  /** @deprecated Kept for cache compat. */
  schemaTypes?: Record<string, string>;
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
  workspaceId: string;
  actorId: string;
  clientId: string;
  accountId?: string;
  userId?: string;
  createdAt: number;
  lastSeenAt: number;
}
