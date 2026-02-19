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

type TaskWatchStatusPayload = {
  status?: string;
  pendingApprovalCount?: number;
};

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

      const callbackArgs = {
        internalSecret: callbackInternalSecret,
        runId: taskId,
        workspaceId,
      };
      let sequence = 0;
      try {
        const client = new ConvexClient(callbackConvexUrl, {
          skipConvexDeploymentUrlCheck: true,
        });
        const unsubscribe = client.onUpdate(
          api.runtimeCallbacks.getTaskWatchStatus,
          callbackArgs,
          (payload: TaskWatchStatusPayload | null | undefined) => {
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
      } catch {
        // ConvexClient requires websocket support, which isn't always available in
        // production HTTP-only Convex function hosts. Fall back to polling-based
        // updates to avoid runtime failures.
        const pollMs = 750;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const poll = async () => {
          if (cancelled) {
            return;
          }

          try {
            const payload = await ctx.runQuery(api.runtimeCallbacks.getTaskWatchStatus, callbackArgs);
            sequence += 1;
            listener({
              id: sequence,
              eventName: "task",
              payload: {
                status: payload?.status,
                pendingApprovalCount: payload?.pendingApprovalCount,
              },
              createdAt: Date.now(),
            });
          } catch {
            // Ignore transient polling failures and continue retrying.
          }

          if (!cancelled) {
            timer = setTimeout(poll, pollMs);
          }
        };

        void poll();

        return () => {
          cancelled = true;
          if (timer) {
            clearTimeout(timer);
          }
        };
      }
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
