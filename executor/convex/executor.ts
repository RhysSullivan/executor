import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { workspaceMutation } from "../lib/functionBuilders";
import { actorIdForAccount } from "../lib/identity";
import { isKnownRuntimeId } from "../lib/runtimes/runtime_catalog";
import type { ApprovalRecord, TaskRecord } from "../lib/types";

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
  await ctx.runMutation(internal.database.createTaskEvent, input);
}

function terminalEventForStatus(status: "completed" | "failed" | "timed_out" | "denied"):
  "task.completed" | "task.failed" | "task.timed_out" | "task.denied" {
  if (status === "completed") return "task.completed";
  if (status === "timed_out") return "task.timed_out";
  if (status === "denied") return "task.denied";
  return "task.failed";
}

async function createTaskRecord(
  ctx: MutationCtx,
  args: {
    code: string;
    timeoutMs?: number;
    runtimeId?: string;
    metadata?: unknown;
    workspaceId: Id<"workspaces">;
    actorId: string;
    clientId?: string;
  },
): Promise<{ task: TaskRecord }> {
  if (!args.code.trim()) {
    throw new Error("Task code is required");
  }

  const runtimeId = args.runtimeId ?? "local-bun";
  if (!isKnownRuntimeId(runtimeId)) {
    throw new Error(`Unsupported runtime: ${runtimeId}`);
  }

  const taskId = `task_${crypto.randomUUID()}`;
  const task = (await ctx.runMutation(internal.database.createTask, {
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
}

async function resolveApprovalRecord(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    approvalId: string;
    decision: "approved" | "denied";
    reviewerId?: string;
    reason?: string;
  },
): Promise<{ approval: ApprovalRecord; task: TaskRecord } | null> {
  const scopedApproval = await ctx.runQuery(internal.database.getApprovalInWorkspace, {
    approvalId: args.approvalId,
    workspaceId: args.workspaceId,
  });
  if (!scopedApproval || scopedApproval.status !== "pending") {
    return null;
  }

  const approval = (await ctx.runMutation(internal.database.resolveApproval, {
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

  const task = (await ctx.runQuery(internal.database.getTask, {
    taskId: approval.taskId,
  })) as TaskRecord | null;
  if (!task) {
    throw new Error(`Task ${approval.taskId} missing while resolving approval`);
  }

  return { approval, task };
}

export const createTask = workspaceMutation({
  args: {
    code: v.string(),
    timeoutMs: v.optional(v.number()),
    runtimeId: v.optional(v.string()),
    metadata: v.optional(v.any()),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ task: TaskRecord }> => {
    const canonicalActorId = actorIdForAccount(ctx.account as { _id: string; provider: string; providerAccountId: string });
    if (args.actorId && args.actorId !== canonicalActorId) {
      throw new Error("actorId must match the authenticated workspace actor");
    }

    return await createTaskRecord(ctx, {
      ...args,
      workspaceId: ctx.workspaceId,
      actorId: canonicalActorId,
      clientId: args.clientId,
    });
  },
});

export const createTaskInternal = internalMutation({
  args: {
    code: v.string(),
    timeoutMs: v.optional(v.number()),
    runtimeId: v.optional(v.string()),
    metadata: v.optional(v.any()),
    workspaceId: v.id("workspaces"),
    actorId: v.string(),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ task: TaskRecord }> => {
    return await createTaskRecord(ctx, args);
  },
});

export const resolveApproval = workspaceMutation({
  args: {
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    reviewerId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ approval: ApprovalRecord; task: TaskRecord } | null> => {
    const canonicalActorId = actorIdForAccount(ctx.account as { _id: string; provider: string; providerAccountId: string });
    if (args.reviewerId && args.reviewerId !== canonicalActorId) {
      throw new Error("reviewerId must match the authenticated workspace actor");
    }

    return await resolveApprovalRecord(ctx, {
      ...args,
      workspaceId: ctx.workspaceId,
      reviewerId: canonicalActorId,
    });
  },
});

export const resolveApprovalInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    reviewerId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ approval: ApprovalRecord; task: TaskRecord } | null> => {
    return await resolveApprovalRecord(ctx, args);
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
    await ctx.runMutation(internal.database.createTaskEvent, {
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

export const completeRuntimeRun = internalMutation({
  args: {
    runId: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out"), v.literal("denied")),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const task = (await ctx.runQuery(internal.database.getTask, { taskId: args.runId })) as TaskRecord | null;
    if (!task) {
      return { ok: false as const, error: `Run not found: ${args.runId}` };
    }

    if (task.status === "completed" || task.status === "failed" || task.status === "timed_out" || task.status === "denied") {
      return { ok: true as const, alreadyFinal: true as const, task };
    }

    const finished = await ctx.runMutation(internal.database.markTaskFinished, {
      taskId: args.runId,
      status: args.status,
      stdout: args.stdout ?? "",
      stderr: args.stderr ?? "",
      exitCode: args.exitCode,
      error: args.error,
    });

    if (!finished) {
      return { ok: false as const, error: `Failed to mark run finished: ${args.runId}` };
    }

    await publishTaskEvent(ctx, {
      taskId: args.runId,
      eventName: "task",
      type: terminalEventForStatus(args.status),
      payload: {
        taskId: args.runId,
        status: finished.status,
        exitCode: finished.exitCode,
        durationMs: args.durationMs,
        error: finished.error,
        completedAt: finished.completedAt,
      },
    });

    return { ok: true as const, alreadyFinal: false as const, task: finished };
  },
});
