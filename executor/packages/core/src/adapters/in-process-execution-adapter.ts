import { APPROVAL_DENIED_PREFIX, APPROVAL_PENDING_PREFIX } from "../execution-constants";
import type {
  ExecutionAdapter,
  ToolCallRequest,
  ToolCallResult,
} from "../types";
import { describeError } from "../utils";

interface InProcessExecutionAdapterOptions {
  runId: string;
  invokeTool: (call: ToolCallRequest) => Promise<unknown>;
}

export class InProcessExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly options: InProcessExecutionAdapterOptions) {}

  async invokeTool(call: ToolCallRequest): Promise<ToolCallResult> {
    if (call.runId !== this.options.runId) {
      return {
        ok: false,
        kind: "failed",
        error: `Run mismatch for call ${call.callId}`,
      };
    }

    try {
      const value = await this.options.invokeTool(call);
      return { ok: true, value };
    } catch (error) {
      const message = describeError(error);
      if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
        return {
          ok: false,
          kind: "denied",
          error: message.replace(APPROVAL_DENIED_PREFIX, "").trim(),
        };
      }

      if (message.startsWith(APPROVAL_PENDING_PREFIX)) {
        return {
          ok: false,
          kind: "pending",
          approvalId: message.replace(APPROVAL_PENDING_PREFIX, "").trim(),
          retryAfterMs: 500,
          error: "Approval pending",
        };
      }

      return {
        ok: false,
        kind: "failed",
        error: message,
      };
    }
  }
}
