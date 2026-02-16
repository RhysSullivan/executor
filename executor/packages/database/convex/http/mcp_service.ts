import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel.d.ts";
import type {
  AnonymousContext,
  PendingApprovalRecord,
  TaskExecutionOutcome,
  TaskRecord,
  ToolDescriptor,
} from "../../../core/src/types";

export function createMcpExecutorService(ctx: ActionCtx) {
  return {
    createTask: async (input: {
      code: string;
      timeoutMs?: number;
      runtimeId?: string;
      metadata?: Record<string, unknown>;
      workspaceId: Id<"workspaces">;
      actorId: string;
      clientId?: string;
    }): Promise<{ task: TaskRecord }> => {
      const taskInput = {
        ...input,
        scheduleAfterCreate: false,
      };
      return await ctx.runMutation(internal.executor.createTaskInternal, taskInput);
    },
    runTaskNow: async (taskId: string): Promise<TaskExecutionOutcome | null> => {
      return await ctx.runAction(internal.executorNode.runTask, { taskId });
    },
    getTask: async (taskId: string, workspaceId?: Id<"workspaces">): Promise<TaskRecord | null> => {
      if (workspaceId) {
        return await ctx.runQuery(internal.database.getTaskInWorkspace, { taskId, workspaceId });
      }
      return null;
    },
    subscribe: () => {
      return () => {};
    },
    bootstrapAnonymousContext: async (sessionId?: string): Promise<AnonymousContext> => {
      return await ctx.runMutation(internal.database.bootstrapAnonymousSession, { sessionId });
    },
    listTools: async (
      toolContext?: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string },
    ): Promise<ToolDescriptor[]> => {
      if (!toolContext) {
        return [];
      }

      return await ctx.runAction(internal.executorNode.listToolsInternal, { ...toolContext });
    },
    listPendingApprovals: async (workspaceId: Id<"workspaces">): Promise<PendingApprovalRecord[]> => {
      return await ctx.runQuery(internal.database.listPendingApprovals, { workspaceId });
    },
    resolveApproval: async (input: {
      workspaceId: Id<"workspaces">;
      approvalId: string;
      decision: "approved" | "denied";
      reviewerId?: string;
      reason?: string;
    }) => {
      return await ctx.runMutation(internal.executor.resolveApprovalInternal, {
        ...input,
      });
    },
  };
}
