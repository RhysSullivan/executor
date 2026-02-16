// ── Shared types (inlined from @executor/contracts) ──────────────────────────

import type { Id } from "../../database/convex/_generated/dataModel.d.ts";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "timed_out" | "denied";
export type ApprovalStatus = "pending" | "approved" | "denied";
export type ToolCallStatus = "requested" | "pending_approval" | "completed" | "failed" | "denied";
export type PolicyDecision = "allow" | "require_approval" | "deny";
export type PolicyScopeType = "account" | "organization" | "workspace";
export type PolicyMatchType = "glob" | "exact";
export type PolicyEffect = "allow" | "deny";
export type PolicyApprovalMode = "inherit" | "auto" | "required";
export type ToolSourceScopeType = "organization" | "workspace";
export type CredentialScopeType = "account" | "organization" | "workspace";
export type CredentialScope = CredentialScopeType;
export type CredentialProvider = "local-convex" | "workos-vault";
export type ToolApprovalMode = "auto" | "required";
export type ToolSourceType = "mcp" | "openapi" | "graphql";

export type JsonSchema = Record<string, unknown>;

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

export interface AccessPolicyRecord {
  id: string;
  scopeType: PolicyScopeType;
  organizationId?: Id<"organizations">;
  workspaceId?: Id<"workspaces">;
  targetAccountId?: Id<"accounts">;
  clientId?: string;
  resourceType: "tool_path";
  resourcePattern: string;
  matchType: PolicyMatchType;
  effect: PolicyEffect;
  approvalMode: PolicyApprovalMode;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialRecord {
  id: string;
  bindingId?: string;
  scopeType: CredentialScopeType;
  accountId?: Id<"accounts">;
  organizationId?: Id<"organizations">;
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
  config: Record<string, unknown>;
  specHash?: string;
  authFingerprint?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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
