// Re-export shared types from contracts
export type {
  TaskStatus,
  ApprovalStatus,
  PolicyDecision,
  CredentialScope,
  CredentialProvider,
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

import type { TaskStatus, CredentialScope, ToolApprovalMode } from "@executor/contracts";

// ── Server-only types ─────────────────────────────────────────────────────────

export interface CreateTaskInput {
  code: string;
  timeoutMs?: number;
  runtimeId?: string;
  metadata?: Record<string, unknown>;
  workspaceId: string;
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
  stdout: string;
  stderr: string;
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
  | { ok: false; error: string; denied?: boolean };

export type RuntimeOutputStream = "stdout" | "stderr";

export interface RuntimeOutputEvent {
  runId: string;
  stream: RuntimeOutputStream;
  line: string;
  timestamp: number;
}

export interface ExecutionAdapter {
  invokeTool(call: ToolCallRequest): Promise<ToolCallResult>;
  emitOutput(event: RuntimeOutputEvent): void | Promise<void>;
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
  workspaceId: string;
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
  /** Raw operationId from the OpenAPI spec (used to generate typechecker wrapper). */
  operationId?: string;
  /**
   * Raw .d.ts from openapi-typescript for this tool's source.
   * Only set on the FIRST tool per source to avoid duplication.
   */
  sourceDts?: string;
  /** @deprecated Use sourceDts instead. Kept for cache compat. */
  schemaTypes?: Record<string, string>;
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
