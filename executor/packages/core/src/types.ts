// ── Shared types (inlined from @executor/contracts) ──────────────────────────

import type { Id } from "../../convex/_generated/dataModel";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "timed_out" | "denied";
export type ApprovalStatus = "pending" | "approved" | "denied";
export type ToolCallStatus = "requested" | "pending_approval" | "completed" | "failed" | "denied";
export type PolicyDecision = "allow" | "require_approval" | "deny";
export type CredentialScope = "workspace" | "actor";
export type CredentialProvider = "local-convex" | "workos-vault";
export type ToolApprovalMode = "auto" | "required";
export type ToolSourceType = "mcp" | "openapi" | "graphql";

export type SourceAuthType = "none" | "bearer" | "apiKey" | "basic" | "mixed";

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
  actorId?: string;
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

export interface AccessPolicyRecord {
  id: string;
  workspaceId: Id<"workspaces">;
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
  bindingId?: string;
  workspaceId: Id<"workspaces">;
  sourceKey: string;
  scope: CredentialScope;
  actorId?: string;
  overridesJson?: Record<string, unknown>;
  boundAuthFingerprint?: string;
  provider: CredentialProvider;
  secretJson: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ToolSourceRecord {
  id: string;
  workspaceId: Id<"workspaces">;
  name: string;
  type: ToolSourceType;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ToolDescriptor {
  path: string;
  description: string;
  approval: ToolApprovalMode;
  source?: string;
  /** Compact display type hint for tool arguments. */
  argsType?: string;
  /** Compact display type hint for tool return value. */
  returnsType?: string;
  /** Full-fidelity args type hint for strict editor/typecheck usage. */
  strictArgsType?: string;
  /** Full-fidelity return type hint for strict editor/typecheck usage. */
  strictReturnsType?: string;
  /** Top-level argument key preview for examples/UI. */
  argPreviewKeys?: string[];
  operationId?: string;
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
  actorId: string;
  clientId: string;
  accountId: string;
  userId: string;
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
  actorId: string;
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

export type ToolCredentialAuthType = "bearer" | "apiKey" | "basic";

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
  actorId?: string;
  clientId?: string;
  credential?: ResolvedToolCredential;
  isToolAllowed: (toolPath: string) => boolean;
}

export interface ToolTypeMetadata {
  /** Lightweight TS type hint for args (for LLM prompt / discover tool). */
  argsType?: string;
  /** Lightweight TS type hint for return value (for LLM prompt / discover tool). */
  returnsType?: string;
  /** Compact args hint intended for UI/discovery display. */
  displayArgsType?: string;
  /** Compact return hint intended for UI/discovery display. */
  displayReturnsType?: string;
  /** Top-level argument keys for examples/UI without parsing type strings. */
  argPreviewKeys?: string[];
  /** Raw operationId from the OpenAPI spec (used to generate typechecker wrapper). */
  operationId?: string;
  /**
   * Raw .d.ts from openapi-typescript for this tool's source.
   * Only set on the FIRST tool per source to avoid duplication.
   */
  sourceDts?: string;
}

export interface ToolDefinition {
  path: string;
  description: string;
  approval: ToolApprovalMode;
  source?: string;
  metadata?: ToolTypeMetadata;
  credential?: ToolCredentialSpec;
  /** For GraphQL sources: the source name used for dynamic path extraction */
  _graphqlSource?: string;
  /** For GraphQL pseudo-tools: marks tools that exist only for discovery/policy */
  _pseudoTool?: boolean;
  /** Serializable data to reconstruct `run` from cache. Attached during tool building. */
  _runSpec?: unknown;
  run(input: unknown, context: ToolRunContext): Promise<unknown>;
}
