import type { Id } from "../../convex/_generated/dataModel.d.ts";
import type { ActionCtx, MutationCtx } from "../../convex/_generated/server";
import { actorIdForAccount } from "../../../core/src/identity";
import { defaultRuntimeId, isKnownRuntimeId, isRuntimeEnabled } from "../../../core/src/runtimes/runtime-catalog";
import type { ApprovalRecord, TaskExecutionOutcome, TaskRecord } from "../../../core/src/types";
import { DEFAULT_TASK_TIMEOUT_MS } from "../task/constants";
import { createTaskEvent } from "../task/events";
import { markTaskFinished } from "../task/finish";
import { isTerminalTaskStatus, taskTerminalEventType } from "../task/status";
import { safeRunAfter } from "../lib/scheduler";

type Internal = typeof import("../../convex/_generated/api").internal;

type TaskCreateContext = Pick<MutationCtx, "runMutation"> & {
  scheduler?: Pick<MutationCtx, "scheduler">["scheduler"];
};

async function createTaskRecord(
  ctx: TaskCreateContext,
  internal: Internal,
  args: {
    code: string;
    timeoutMs?: number;
    runtimeId?: string;
    metadata?: unknown;
    workspaceId: Id<"workspaces">;
    actorId: string;
    clientId?: string;
    scheduleAfterCreate?: boolean;
  },
): Promise<{ task: TaskRecord }> {
  if (!args.code.trim()) {
    throw new Error("Task code is required");
  }

  const runtimeId = args.runtimeId ?? defaultRuntimeId();
  if (!isKnownRuntimeId(runtimeId)) {
    throw new Error(`Unsupported runtime: ${runtimeId}`);
  }
  if (!isRuntimeEnabled(runtimeId)) {
    throw new Error(`Runtime is disabled for this deployment: ${runtimeId}`);
  }

  const taskId = `task_${crypto.randomUUID()}`;
  const task = (await ctx.runMutation(internal.database.createTask, {
    id: taskId,
    code: args.code,
    runtimeId,
    timeoutMs: args.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    metadata: args.metadata,
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    clientId: args.clientId,
  })) as TaskRecord;

  await createTaskEvent(ctx, {
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

  await createTaskEvent(ctx, {
    taskId,
    eventName: "task",
    type: "task.queued",
    payload: {
      taskId,
      status: "queued",
    },
  });

  if (args.scheduleAfterCreate ?? true) {
    if (!ctx.scheduler) {
      throw new Error("Task scheduling is unavailable in this execution context");
    }

    await safeRunAfter(ctx.scheduler, 1, internal.executorNode.runTask, { taskId });
  }

  return { task };
}

async function resolveApprovalRecord(
  ctx: MutationCtx,
  internal: Internal,
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

  await createTaskEvent(ctx, {
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

export async function createTaskHandler(
  ctx: ActionCtx,
  internal: Internal,
  args: {
    code: string;
    timeoutMs?: number;
    runtimeId?: string;
    metadata?: unknown;
    workspaceId: Id<"workspaces">;
    sessionId?: string;
    actorId?: string;
    clientId?: string;
    waitForResult?: boolean;
  },
): Promise<TaskExecutionOutcome> {
  const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
  });

  const canonicalActorId = actorIdForAccount({
    _id: access.accountId,
    provider: access.provider,
    providerAccountId: access.providerAccountId,
  });

  if (args.actorId && args.actorId !== canonicalActorId) {
    throw new Error("actorId must match the authenticated workspace actor");
  }

  const waitForResult = args.waitForResult ?? false;
  const created = await ctx.runMutation(internal.executor.createTaskInternal, {
    code: args.code,
    timeoutMs: args.timeoutMs,
    runtimeId: args.runtimeId,
    metadata: args.metadata,
    workspaceId: args.workspaceId,
    actorId: canonicalActorId,
    clientId: args.clientId,
    scheduleAfterCreate: !waitForResult,
  });

  if (!waitForResult) {
    return { task: created.task as TaskRecord };
  }

  const runOutcome = await ctx.runAction(internal.executorNode.runTask, {
    taskId: created.task.id,
  });

  if (runOutcome?.task) {
    return runOutcome;
  }

  const task = await ctx.runQuery(internal.database.getTaskInWorkspace, {
    taskId: created.task.id,
    workspaceId: args.workspaceId,
  });

  if (!task) {
    throw new Error(`Task ${created.task.id} not found after execution`);
  }

  return { task };
}

export async function createTaskInternalHandler(
  ctx: MutationCtx,
  internal: Internal,
  args: {
    code: string;
    timeoutMs?: number;
    runtimeId?: string;
    metadata?: unknown;
    workspaceId: Id<"workspaces">;
    actorId: string;
    clientId?: string;
    scheduleAfterCreate?: boolean;
  },
): Promise<{ task: TaskRecord }> {
  return await createTaskRecord(ctx, internal, args);
}

export async function resolveApprovalHandler(
  ctx: unknown,
  internal: Internal,
  args: {
    approvalId: string;
    decision: "approved" | "denied";
    reviewerId?: string;
    reason?: string;
  },
): Promise<{ approval: ApprovalRecord; task: TaskRecord } | null> {
  const typedCtx = ctx as MutationCtx & {
    account: { _id: string; provider: string; providerAccountId: string };
    workspaceId: Id<"workspaces">;
  };

  const canonicalActorId = actorIdForAccount(typedCtx.account);
  if (args.reviewerId && args.reviewerId !== canonicalActorId) {
    throw new Error("reviewerId must match the authenticated workspace actor");
  }

  return await resolveApprovalRecord(typedCtx, internal, {
    ...args,
    workspaceId: typedCtx.workspaceId,
    reviewerId: canonicalActorId,
  });
}

export async function resolveApprovalInternalHandler(
  ctx: MutationCtx,
  internal: Internal,
  args: {
    workspaceId: Id<"workspaces">;
    approvalId: string;
    decision: "approved" | "denied";
    reviewerId?: string;
    reason?: string;
  },
): Promise<{ approval: ApprovalRecord; task: TaskRecord } | null> {
  return await resolveApprovalRecord(ctx, internal, args);
}

export async function completeRuntimeRunHandler(
  ctx: MutationCtx,
  internal: Internal,
  args: {
    runId: string;
    status: "completed" | "failed" | "timed_out" | "denied";
    exitCode?: number;
    error?: string;
    durationMs?: number;
  },
) {
  const task = (await ctx.runQuery(internal.database.getTask, { taskId: args.runId })) as TaskRecord | null;
  if (!task) {
    return { ok: false as const, error: `Run not found: ${args.runId}` };
  }

  if (isTerminalTaskStatus(task.status)) {
    return { ok: true as const, alreadyFinal: true as const, task };
  }

  const finished = await markTaskFinished(ctx, {
    taskId: args.runId,
    status: args.status,
    exitCode: args.exitCode,
    error: args.error,
  });

  if (!finished) {
    return { ok: false as const, error: `Failed to mark run finished: ${args.runId}` };
  }

  await createTaskEvent(ctx, {
    taskId: args.runId,
    eventName: "task",
    type: taskTerminalEventType(args.status),
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
}
