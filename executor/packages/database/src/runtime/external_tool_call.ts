"use node";

import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { TaskRecord, ToolCallResult } from "../../../core/src/types";
import { decodeToolCallControlSignal } from "../../../core/src/tool-call-control";
import { describeError } from "../../../core/src/utils";
import { invokeTool } from "./tool_invocation";

async function getTaskById(ctx: ActionCtx, taskId: string): Promise<TaskRecord | null> {
  return await ctx.runQuery(internal.database.getTask, { taskId }) as TaskRecord | null;
}

export async function handleExternalToolCallRequest(
  ctx: ActionCtx,
  args: {
    runId: string;
    callId: string;
    toolPath: string;
    input?: unknown;
  },
): Promise<ToolCallResult> {
  const task = await getTaskById(ctx, args.runId);
  if (!task) {
    return {
      ok: false,
      kind: "failed",
      error: `Run not found: ${args.runId}`,
    };
  }

  try {
    const value = await invokeTool(ctx, task, {
      runId: args.runId,
      callId: args.callId,
      toolPath: args.toolPath,
      input: args.input ?? {},
    });
    return { ok: true, value };
  } catch (error) {
    const controlSignal = decodeToolCallControlSignal(error);
    if (controlSignal?.kind === "approval_pending") {
      return {
        ok: false,
        kind: "pending",
        approvalId: controlSignal.approvalId,
        retryAfterMs: 0,
        error: "Approval pending",
      };
    }
    if (controlSignal?.kind === "approval_denied") {
      return {
        ok: false,
        kind: "denied",
        error: controlSignal.reason,
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
