import type { ActionCtx, MutationCtx, QueryCtx } from "../../convex/_generated/server";

type InternalApi = typeof import("../../convex/_generated/api").internal;

function requireInternalSecret(secret: string): void {
  const expected = process.env.EXECUTOR_INTERNAL_TOKEN;
  if (!expected) {
    throw new Error("EXECUTOR_INTERNAL_TOKEN is not configured");
  }
  if (secret !== expected) {
    throw new Error("Unauthorized: invalid internal secret");
  }
}

export async function handleToolCallHandler(
  ctx: Pick<ActionCtx, "runAction">,
  internalApi: InternalApi,
  args: {
    internalSecret: string;
    runId: string;
    callId: string;
    toolPath: string;
    input?: Record<string, unknown>;
  },
): Promise<string> {
  requireInternalSecret(args.internalSecret);
  return await ctx.runAction(internalApi.executorNode.handleExternalToolCall, {
    runId: args.runId,
    callId: args.callId,
    toolPath: args.toolPath,
    input: args.input as Record<string, any> | undefined,
  });
}

export async function completeRunHandler(
  ctx: Pick<MutationCtx, "runMutation">,
  internalApi: InternalApi,
  args: {
    internalSecret: string;
    runId: string;
    status: "completed" | "failed" | "timed_out" | "denied";
    exitCode?: number;
    error?: string;
    durationMs?: number;
  },
) {
  requireInternalSecret(args.internalSecret);

  return await ctx.runMutation(internalApi.executor.completeRuntimeRun, {
    runId: args.runId,
    status: args.status,
    exitCode: args.exitCode,
    error: args.error,
    durationMs: args.durationMs,
  });
}

export async function getApprovalStatusHandler(
  ctx: Pick<QueryCtx, "runQuery">,
  internalApi: InternalApi,
  args: {
    internalSecret: string;
    runId: string;
    approvalId: string;
  },
) {
  requireInternalSecret(args.internalSecret);

  const approval = await ctx.runQuery(internalApi.database.getApproval, {
    approvalId: args.approvalId,
  });

  if (!approval || approval.taskId !== args.runId) {
    return { status: "missing" as const };
  }

  return { status: approval.status };
}
