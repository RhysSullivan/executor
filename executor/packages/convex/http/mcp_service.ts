import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type {
  AnonymousContext,
  PendingApprovalRecord,
  TaskRecord,
  ToolDescriptor,
} from "../../core/src/types";

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
    }) => {
      return (await ctx.runMutation(internal.executor.createTaskInternal, {
        ...input,
      })) as { task: TaskRecord };
    },
    getTask: async (taskId: string, workspaceId?: Id<"workspaces">) => {
      if (workspaceId) {
        return (await ctx.runQuery(internal.database.getTaskInWorkspace, { taskId, workspaceId })) as TaskRecord | null;
      }
      return null;
    },
    subscribe: () => {
      return () => {};
    },
    bootstrapAnonymousContext: async (sessionId?: string) => {
      return (await ctx.runMutation(internal.database.bootstrapAnonymousSession, { sessionId })) as AnonymousContext;
    },
    listTools: async (toolContext?: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string }) => {
      if (!toolContext) {
        return [];
      }

      return (await ctx.runAction(internal.executorNode.listToolsInternal, { ...toolContext })) as ToolDescriptor[];
    },
    listToolsForTypecheck: async (toolContext: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string }) => {
      const result = await ctx.runAction(internal.executorNode.listToolsWithWarningsInternal, { ...toolContext }) as {
        tools: ToolDescriptor[];
        dtsUrls?: Record<string, string>;
      };

      return {
        tools: result.tools,
        dtsUrls: result.dtsUrls ?? {},
      };
    },
    typecheckRunCode: async (input: {
      code: string;
      workspaceId: Id<"workspaces">;
      actorId?: string;
      clientId?: string;
    }) => {
      const result = await ctx.runAction(internal.mcpNode.typecheckRunCodeInternal, {
        code: input.code,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        clientId: input.clientId,
      });
      return result;
    },
    listPendingApprovals: async (workspaceId: Id<"workspaces">) => {
      return (await ctx.runQuery(internal.database.listPendingApprovals, { workspaceId })) as PendingApprovalRecord[];
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
