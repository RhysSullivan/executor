import type {
  CodeExecutor,
  ExecuteResult,
} from "@executor/codemode-core";
import type {
  ExecutorBackend,
  ExecutorBackendRepositories,
} from "@executor/platform-sdk/backend";
import type {
  Executor,
  ExecutorMcpSourceInput,
  ExecutorSourceBatchInput,
  ExecutorSourceInput,
  ExecutorSourceOAuthInput,
} from "@executor/platform-sdk/executor";
import type {
  ResolveSecretMaterial,
} from "@executor/platform-sdk/runtime";

// ---------------------------------------------------------------------------
// Tool approval
// ---------------------------------------------------------------------------

export type ToolApprovalRequest = {
  toolPath: string;
  sourceId: string;
  sourceName: string;
  operationKind: "read" | "write" | "delete" | "execute" | "unknown";
  args: unknown;
  reason: string;
  approvalLabel: string | null;
  context?: Record<string, unknown>;
};

export type ToolApprovalResponse =
  | { approved: true }
  | { approved: false; reason?: string };

export type OnToolApproval =
  | "allow-all"
  | "deny-all"
  | ((
      request: ToolApprovalRequest,
    ) => Promise<ToolApprovalResponse> | ToolApprovalResponse);

// ---------------------------------------------------------------------------
// Interactions (URL auth, forms)
// ---------------------------------------------------------------------------

export type UrlInteraction = {
  kind: "url";
  url: string;
  message: string;
  sourceId?: string;
  context?: Record<string, unknown>;
};

export type FormInteraction = {
  kind: "form";
  message: string;
  requestedSchema: Record<string, unknown>;
  toolPath?: string;
  sourceId?: string;
  context?: Record<string, unknown>;
};

export type InteractionRequest = UrlInteraction | FormInteraction;

export type InteractionResponse =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline"; reason?: string }
  | { action: "cancel" };

export type OnInteraction = (
  request: InteractionRequest,
) => Promise<InteractionResponse> | InteractionResponse;

// ---------------------------------------------------------------------------
// Runtime (code execution)
// ---------------------------------------------------------------------------

export type BuiltinRuntime = "quickjs" | "ses" | "deno";

export type RuntimeOption = BuiltinRuntime | CodeExecutor;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type SimpleFS = {
  readFile: (path: string) => Promise<string | Buffer>;
  writeFile: (path: string, data: string | Buffer) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  rm: (path: string) => Promise<void>;
};

export type FileStorageOptions = {
  kind: "file";
  cwd?: string;
  workspaceRoot?: string;
  fs?: SimpleFS;
};

export type CustomStorageOptions = {
  loadRepositories: (
    options: unknown,
  ) => ExecutorBackendRepositories | Promise<ExecutorBackendRepositories>;
};

export type StorageOption =
  | "memory"
  | FileStorageOptions
  | CustomStorageOptions
  | ExecutorBackend;

// ---------------------------------------------------------------------------
// Inline tools
// ---------------------------------------------------------------------------

export type SimpleTool = {
  description?: string;
  /** Optional input schema (zod, valibot, arktype — any Standard Schema). Omit for no validation. */
  inputSchema?: import("@standard-schema/spec").StandardSchemaV1;
  execute: (...args: any[]) => unknown;
};

export type ToolsOption = Record<string, SimpleTool>;

// ---------------------------------------------------------------------------
// createExecutor options
// ---------------------------------------------------------------------------

export type CreateExecutorOptions = {
  runtime?: RuntimeOption;
  storage?: StorageOption;
  tools?: ToolsOption;
  onToolApproval?: OnToolApproval;
  onInteraction?: OnInteraction;
  resolveSecret?: (input: {
    secretId: string;
    context?: Record<string, unknown>;
  }) => Promise<string | null> | string | null;
};

// ---------------------------------------------------------------------------
// ExecutorSDK – the public surface
// ---------------------------------------------------------------------------

export type { ExecuteResult };

export type ExecutorSDK = {
  execute: (code: string) => Promise<ExecuteResult>;

  sources: Executor["sources"];
  policies: Executor["policies"];
  secrets: Executor["secrets"];
  oauth: Executor["oauth"];
  local: Executor["local"];

  close: () => Promise<void>;
};
