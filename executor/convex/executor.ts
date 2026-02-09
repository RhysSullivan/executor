import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation } from "./_generated/server";
import type { ApprovalRecord, TaskRecord } from "./lib/types";

const DEFAULT_TIMEOUT_MS = 300_000;

async function publishTaskEvent(
  ctx: MutationCtx,
  input: {
    taskId: string;
    eventName: string;
    type: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.runMutation(api.database.createTaskEvent, input);
}

export const createTask = mutation({
  args: {
    code: v.string(),
    timeoutMs: v.optional(v.number()),
    runtimeId: v.optional(v.string()),
    metadata: v.optional(v.any()),
    workspaceId: v.string(),
    actorId: v.string(),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ task: TaskRecord }> => {
    if (!args.code.trim()) {
      throw new Error("Task code is required");
    }

    const runtimeId = args.runtimeId ?? "local-bun";
    if (runtimeId !== "local-bun") {
      throw new Error(`Unsupported runtime: ${runtimeId}`);
    }

    const taskId = `task_${crypto.randomUUID()}`;
    const task = (await ctx.runMutation(api.database.createTask, {
      id: taskId,
      code: args.code,
      runtimeId,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      metadata: args.metadata,
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      clientId: args.clientId,
    })) as TaskRecord;

    await publishTaskEvent(ctx, {
      taskId,
      eventName: "task",
      type: "task.created",
      payload: {
        taskId,
        status: task.status,
        runtimeId: task.runtimeId,
        timeoutMs: task.timeoutMs,
        workspaceId: task.workspaceId,
        actorId: task.actorId,
        clientId: task.clientId,
        createdAt: task.createdAt,
      },
    });

    await publishTaskEvent(ctx, {
      taskId,
      eventName: "task",
      type: "task.queued",
      payload: {
        taskId,
        status: "queued",
      },
    });

    await ctx.scheduler.runAfter(1, internal.executorNode.runTask, {
      taskId,
    });

    return { task };
  },
});

export const resolveApproval = mutation({
  args: {
    workspaceId: v.string(),
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    reviewerId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ approval: ApprovalRecord; task: TaskRecord } | null> => {
    const scopedApproval = await ctx.runQuery(api.database.getApprovalInWorkspace, {
      approvalId: args.approvalId,
      workspaceId: args.workspaceId,
    });
    if (!scopedApproval || scopedApproval.status !== "pending") {
      return null;
    }

    const approval = (await ctx.runMutation(api.database.resolveApproval, {
      approvalId: args.approvalId,
      decision: args.decision,
      reviewerId: args.reviewerId,
      reason: args.reason,
    })) as ApprovalRecord | null;
    if (!approval) {
      return null;
    }

    await publishTaskEvent(ctx, {
      taskId: approval.taskId,
      eventName: "approval",
      type: "approval.resolved",
      payload: {
        approvalId: approval.id,
        taskId: approval.taskId,
        toolPath: approval.toolPath,
        decision: approval.status,
        reviewerId: approval.reviewerId,
        reason: approval.reason,
        resolvedAt: approval.resolvedAt,
      },
    });

    const task = (await ctx.runQuery(api.database.getTask, {
      taskId: approval.taskId,
    })) as TaskRecord | null;
    if (!task) {
      throw new Error(`Task ${approval.taskId} missing while resolving approval`);
    }

    return { approval, task };
  },
});

export const appendRuntimeOutput = internalMutation({
  args: {
    runId: v.string(),
    stream: v.union(v.literal("stdout"), v.literal("stderr")),
    line: v.string(),
    timestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(api.database.createTaskEvent, {
      taskId: args.runId,
      eventName: "task",
      type: args.stream === "stdout" ? "task.stdout" : "task.stderr",
      payload: {
        taskId: args.runId,
        line: args.line,
        timestamp: args.timestamp ?? Date.now(),
      },
    });

    return { ok: true as const };
  },
});
