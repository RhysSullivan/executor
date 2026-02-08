// Re-export shared types from contracts
export type {
  TaskStatus,
  ApprovalStatus,
  PolicyDecision,
  CredentialScope,
  ToolApprovalMode,
  ToolSourceType,
  TaskRecord,
  ApprovalRecord,
  PendingApprovalRecord,
  TaskEventRecord,
  AccessPolicyRecord,
  CredentialRecord,
  ToolSourceRecord,
  ToolDescriptor,
  AnonymousContext,
} from "@executor/contracts";

// ── Web-only types ────────────────────────────────────────────────────────────

import type { TaskStatus, ApprovalStatus, CredentialScope } from "@executor/contracts";

export type ApprovalDecision = "approved" | "denied";

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
  scope: CredentialScope;
  actorId?: string;
  hasSecret: boolean;
}
