"use node";

import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { APPROVAL_DENIED_PREFIX } from "../../../core/src/execution-constants";
import type { TaskRecord } from "../../../core/src/types";
import { publishTaskEvent } from "./events";

async function finishToolCall(
  ctx: ActionCtx,
  args: {
    taskId: string;
    callId: string;
    status: "completed" | "failed" | "denied";
    error?: string;
  },
): Promise<void> {
  await ctx.runMutation(internal.database.finishToolCall, args);
}

export async function denyToolCall(
  ctx: ActionCtx,
  args: {
    task: TaskRecord;
    callId: string;
    toolPath: string;
    deniedMessage: string;
    approvalId?: string;
    reason?: string;
  },
): Promise<never> {
  await finishToolCall(ctx, {
    taskId: args.task.id,
    callId: args.callId,
    status: "denied",
    error: args.deniedMessage,
  });
  await publishTaskEvent(ctx, args.task.id, "task", "tool.call.denied", {
    taskId: args.task.id,
    callId: args.callId,
    toolPath: args.toolPath,
    ...(args.approvalId ? { approvalId: args.approvalId } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  });
  throw new Error(`${APPROVAL_DENIED_PREFIX}${args.deniedMessage}`);
}

export async function completeToolCall(
  ctx: ActionCtx,
  args: {
    taskId: string;
    callId: string;
    toolPath: string;
  },
): Promise<void> {
  await finishToolCall(ctx, {
    taskId: args.taskId,
    callId: args.callId,
    status: "completed",
  });
  await publishTaskEvent(ctx, args.taskId, "task", "tool.call.completed", {
    taskId: args.taskId,
    callId: args.callId,
    toolPath: args.toolPath,
    outputRedacted: true,
  });
}

export async function failToolCall(
  ctx: ActionCtx,
  args: {
    taskId: string;
    callId: string;
    toolPath: string;
    error: string;
  },
): Promise<void> {
  await finishToolCall(ctx, {
    taskId: args.taskId,
    callId: args.callId,
    status: "failed",
    error: args.error,
  });
  await publishTaskEvent(ctx, args.taskId, "task", "tool.call.failed", {
    taskId: args.taskId,
    callId: args.callId,
    toolPath: args.toolPath,
    error: args.error,
  });
}
