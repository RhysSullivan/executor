import { ConvexClient } from "convex/browser";
import type { LiveTaskEvent } from "../../../core/src/events";
import type {
  AnonymousContext,
  PendingApprovalRecord,
  TaskExecutionOutcome,
  TaskRecord,
  ToolDescriptor,
} from "../../../core/src/types";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel.d.ts";
import type { ActionCtx } from "../_generated/server";

export function createMcpExecutorService(ctx: ActionCtx) {
  return {
    createTask: async (input: {
      code: string;
      timeoutMs?: number;
      runtimeId?: string;
      metadata?: Record<string, unknown>;
      workspaceId: Id<"workspaces">;
      accountId: Id<"accounts">;
      clientId?: string;
    }): Promise<{ task: TaskRecord }> => {
      const taskInput = {
        code: input.code,
        timeoutMs: input.timeoutMs,
        runtimeId: input.runtimeId,
        metadata: input.metadata,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        clientId: input.clientId,
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
    subscribe: (taskId: string, workspaceId: Id<"workspaces">, listener: (event: LiveTaskEvent) => void) => {
      const callbackConvexUrl = process.env.CONVEX_URL ?? process.env.CONVEX_SITE_URL;
      const callbackInternalSecret = process.env.EXECUTOR_INTERNAL_TOKEN;
      if (!callbackConvexUrl || !callbackInternalSecret) {
        return () => {};
      }

      const client = new ConvexClient(callbackConvexUrl, {
        skipConvexDeploymentUrlCheck: true,
      });
      let sequence = 0;
      const unsubscribe = client.onUpdate(
        api.runtimeCallbacks.getTaskWatchStatus,
        {
          internalSecret: callbackInternalSecret,
          runId: taskId,
          workspaceId,
        },
        (payload: unknown) => {
          sequence += 1;
          listener({
            id: sequence,
            eventName: "task",
            payload,
            createdAt: Date.now(),
          });
        },
      );

      return () => {
        unsubscribe();
        client.close();
      };
    },
    bootstrapAnonymousContext: async (sessionId?: string): Promise<AnonymousContext> => {
      return await ctx.runMutation(internal.database.bootstrapAnonymousSession, {
        sessionId,
        clientId: "mcp",
      });
    },
    listTools: async (
      toolContext?: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
    ): Promise<ToolDescriptor[]> => {
      if (!toolContext) {
        return [];
      }

      return await ctx.runAction(internal.executorNode.listToolsInternal, {
        workspaceId: toolContext.workspaceId,
        accountId: toolContext.accountId,
        clientId: toolContext.clientId,
      });
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
