export type RunTerminalStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "denied";

export type ExecuteRunInput = {
  runId?: string;
  code: string;
  timeoutMs?: number;
  context?: {
    controlPlaneBaseUrl?: string;
  };
};

export type ExecuteRunResult = {
  runId: string;
  status: RunTerminalStatus | "waiting_for_interaction";
  result?: unknown;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  interactionId?: string;
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
      interactionId: string;
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
