import { decodeToolCallControlSignal } from "../../../tool-call-control";
import type {
  ExecutionAdapter,
  ToolCallRequest,
  ToolCallResult,
} from "../../../types";
import { describeError } from "../../../utils";

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
      const controlSignal = decodeToolCallControlSignal(error);
      if (controlSignal?.kind === "approval_denied") {
        return {
          ok: false,
          kind: "denied",
          error: controlSignal.reason,
        };
      }

      if (controlSignal?.kind === "approval_pending") {
        return {
          ok: false,
          kind: "pending",
          approvalId: controlSignal.approvalId,
          retryAfterMs: 500,
          error: "Approval pending",
        };
      }

      const message = describeError(error);

      return {
        ok: false,
        kind: "failed",
        error: message,
      };
    }
  }
}
