"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { APPROVAL_DENIED_PREFIX, APPROVAL_PENDING_PREFIX } from "../../core/src/execution-constants";
import type { TaskRecord, ToolCallResult } from "../../core/src/types";
import { describeError } from "../../core/src/utils";
import { invokeTool } from "./tool_invocation";

export async function handleExternalToolCallRequest(
  ctx: ActionCtx,
  args: {
    runId: string;
    callId: string;
    toolPath: string;
    input?: unknown;
  },
): Promise<ToolCallResult> {
  const task = (await ctx.runQuery(internal.database.getTask, {
    taskId: args.runId,
  })) as TaskRecord | null;
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
    const message = describeError(error);
    if (message.startsWith(APPROVAL_PENDING_PREFIX)) {
      const approvalId = message.replace(APPROVAL_PENDING_PREFIX, "").trim();
      return {
        ok: false,
        kind: "pending",
        approvalId,
        retryAfterMs: 0,
        error: "Approval pending",
      };
    }
    if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
      return {
        ok: false,
        kind: "denied",
        error: message.replace(APPROVAL_DENIED_PREFIX, "").trim(),
      };
    }

    return {
      ok: false,
      kind: "failed",
      error: message,
    };
  }
}
