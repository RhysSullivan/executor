export type RunTerminalStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "denied";

export type ExecuteRunInput = {
  code: string;
  timeoutMs?: number;
};

export type ExecuteRunResult = {
  runId: string;
  status: RunTerminalStatus;
  result?: unknown;
  error?: string;
  exitCode?: number;
  durationMs?: number;
};

export interface ExecutorRunClient {
  execute(input: ExecuteRunInput): Promise<ExecuteRunResult>;
}

export type RuntimeToolCallCredentialContext = {
  workspaceId: string;
  sourceKey: string;
  organizationId?: string | null;
  accountId?: string | null;
};

export type RuntimeToolCallRequest = {
  runId: string;
  callId: string;
  toolPath: string;
  input?: Record<string, unknown>;
  credentialContext?: RuntimeToolCallCredentialContext;
};

export type RuntimeToolCallResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      kind: "pending";
      approvalId: string;
      retryAfterMs: number;
      error?: string;
    }
  | {
      ok: false;
      kind: "denied";
      error: string;
    }
  | {
      ok: false;
      kind: "failed";
      error: string;
    };

export interface RuntimeToolCallHandler {
  handleToolCall(input: RuntimeToolCallRequest): Promise<RuntimeToolCallResult>;
}

export type ExecutorServer = {
  runClient: ExecutorRunClient;
  toolCallHandler: RuntimeToolCallHandler;
};

export const createExecutorRunClient = (
  execute: ExecutorRunClient["execute"],
): ExecutorRunClient => ({
  execute,
});


