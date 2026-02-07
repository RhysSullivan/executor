// Re-declare types locally since we can't use the monorepo contracts package
// from the Next.js app easily. These mirror @executor/contracts exactly.

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "denied";

export type ApprovalStatus = "pending" | "approved" | "denied";
export type ApprovalDecision = "approved" | "denied";
export type PolicyDecision = "allow" | "require_approval" | "deny";
export type CredentialScope = "workspace" | "actor";

export interface CreateTaskRequest {
  code: string;
  runtimeId?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  workspaceId: string;
  actorId: string;
  clientId?: string;
}

export interface CreateTaskResponse {
  taskId: string;
  status: TaskStatus;
}

export interface TaskRecord {
  id: string;
  code: string;
  runtimeId: string;
  timeoutMs: number;
  metadata: Record<string, unknown>;
  workspaceId: string;
  actorId?: string;
  clientId?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  toolPath: string;
  input: unknown;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
  reviewerId?: string;
  reason?: string;
}

export interface PendingApprovalRecord extends ApprovalRecord {
  task: Pick<
    TaskRecord,
    "id" | "status" | "runtimeId" | "timeoutMs" | "createdAt"
  >;
}

export interface ResolveApprovalRequest {
  workspaceId: string;
  decision: ApprovalDecision;
  reviewerId?: string;
  reason?: string;
}

export interface AnonymousContext {
  sessionId: string;
  workspaceId: string;
  actorId: string;
  clientId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface RuntimeTargetDescriptor {
  id: string;
  label: string;
  description: string;
}

export interface ToolDescriptor {
  path: string;
  description: string;
  approval: "auto" | "required";
  source?: string;
  argsType?: string;
  returnsType?: string;
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

export interface CredentialDescriptor {
  id: string;
  workspaceId: string;
  sourceKey: string;
  scope: CredentialScope;
  actorId?: string;
  hasSecret: boolean;
}

export interface ToolSourceRecord {
  id: string;
  workspaceId: string;
  name: string;
  type: "mcp" | "openapi";
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEventRecord {
  id: number;
  taskId: string;
  eventName: "task" | "approval";
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}
