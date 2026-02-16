"use node";

import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type {
  AccessPolicyRecord,
  PolicyDecision,
  ResolvedToolCredential,
  TaskRecord,
  ToolDefinition,
  ToolCallRecord,
  ToolCallRequest,
  ToolRunContext,
} from "../../../core/src/types";
import { describeError } from "../../../core/src/utils";
import {
  decodeToolCallControlSignal,
  ToolCallControlError,
} from "../../../core/src/tool-call-control";
import { asPayload } from "../lib/object";
import { getToolDecision, getDecisionForContext } from "./policy";
import { baseTools } from "./workspace_tools";
import { publishTaskEvent } from "./events";
import { completeToolCall, denyToolCall, failToolCall } from "./tool_call_lifecycle";
import { resolveCredentialHeaders, validatePersistedCallRunnable } from "./tool_call_credentials";
import { getGraphqlDecision, resolveToolForCall } from "./tool_call_resolution";
import { getReadyRegistryBuildId } from "./tool_registry_state";

function createApprovalId(): string {
  return `approval_${crypto.randomUUID()}`;
}

type RegistryToolEntry = {
  path: string;
  preferredPath?: string;
  source?: string;
  approval: ToolDefinition["approval"];
  description?: string;
  displayInput?: string;
  displayOutput?: string;
};

async function upsertRequestedToolCall(
  ctx: ActionCtx,
  args: { taskId: string; callId: string; workspaceId: TaskRecord["workspaceId"]; toolPath: string },
): Promise<ToolCallRecord> {
  return await ctx.runMutation(internal.database.upsertToolCallRequested, args) as ToolCallRecord;
}

async function listWorkspaceAccessPolicies(
  ctx: ActionCtx,
  workspaceId: TaskRecord["workspaceId"],
): Promise<AccessPolicyRecord[]> {
  return await ctx.runQuery(internal.database.listAccessPolicies, { workspaceId }) as AccessPolicyRecord[];
}

async function listRegistryNamespaces(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; limit: number },
): Promise<Array<{ namespace: string; toolCount: number; samplePaths: string[] }>> {
  return await ctx.runQuery(internal.toolRegistry.listNamespaces, args) as Array<{
    namespace: string;
    toolCount: number;
    samplePaths: string[];
  }>;
}

async function searchRegistryTools(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; query: string; limit: number },
): Promise<RegistryToolEntry[]> {
  return await ctx.runQuery(internal.toolRegistry.searchTools, args) as RegistryToolEntry[];
}

async function listRegistryToolsByNamespace(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; namespace: string; limit: number },
): Promise<RegistryToolEntry[]> {
  return await ctx.runQuery(internal.toolRegistry.listToolsByNamespace, args) as RegistryToolEntry[];
}

async function denyToolCallForApproval(
  ctx: ActionCtx,
  args: {
    task: TaskRecord;
    callId: string;
    toolPath: string;
    approvalId: string;
  },
): Promise<never> {
  const deniedMessage = `${args.toolPath} (${args.approvalId})`;
  return await denyToolCall(ctx, {
    task: args.task,
    callId: args.callId,
    toolPath: args.toolPath,
    deniedMessage,
    approvalId: args.approvalId,
  });
}

export async function invokeTool(ctx: ActionCtx, task: TaskRecord, call: ToolCallRequest): Promise<unknown> {
  const { toolPath, input, callId } = call;
  const persistedCall = await upsertRequestedToolCall(ctx, {
    taskId: task.id,
    callId,
    workspaceId: task.workspaceId,
    toolPath,
  });
  const runnable = validatePersistedCallRunnable(persistedCall, callId);
  if (runnable.isErr()) {
    throw runnable.error;
  }

  let effectiveToolPath = toolPath;
  try {
    const typedPolicies = await listWorkspaceAccessPolicies(ctx, task.workspaceId);
    const finalizeImmediateTool = async (value: unknown): Promise<unknown> => {
      if (persistedCall.status === "requested") {
        await publishTaskEvent(ctx, task.id, "task", "tool.call.started", {
          taskId: task.id,
          callId,
          toolPath,
          approval: "auto",
        });
      }
      await completeToolCall(ctx, {
        taskId: task.id,
        callId,
        toolPath,
      });
      return value;
    };

    // Fast system tools are handled server-side from the registry.
    if (toolPath === "discover" || toolPath === "catalog.namespaces" || toolPath === "catalog.tools") {
      const buildId = await getReadyRegistryBuildId(ctx, {
        workspaceId: task.workspaceId,
        actorId: task.actorId,
        clientId: task.clientId,
        refreshOnStale: true,
      });

      const payload = typeof input === "string"
        ? { query: input }
        : asPayload(input);
      const isAllowed = (path: string, approval: ToolDefinition["approval"]) => {
        const policyProbeTool: ToolDefinition = {
          path,
          approval,
          description: "",
          run: async () => null,
        };
        return getDecisionForContext(
          policyProbeTool,
          { workspaceId: task.workspaceId, actorId: task.actorId, clientId: task.clientId },
          typedPolicies,
        ) !== "deny";
      };

      const normalizeHint = (value: unknown, fallback: string) => {
        const str = typeof value === "string" ? value.trim() : "";
        return str.length > 0 ? str : fallback;
      };

      if (toolPath === "catalog.namespaces") {
        const limit = Math.max(1, Math.min(200, Number(payload.limit ?? 200)));
        const namespaces = await listRegistryNamespaces(ctx, {
          workspaceId: task.workspaceId,
          buildId,
          limit,
        });
        return await finalizeImmediateTool({ namespaces, total: namespaces.length });
      }

      if (toolPath === "catalog.tools") {
        const namespace = String(payload.namespace ?? "").trim().toLowerCase();
        const query = String(payload.query ?? "").trim();
        const limit = Math.max(1, Math.min(200, Number(payload.limit ?? 50)));

        const raw = query
          ? await searchRegistryTools(ctx, {
              workspaceId: task.workspaceId,
              buildId,
              query,
              limit,
            })
          : namespace
            ? await listRegistryToolsByNamespace(ctx, {
                workspaceId: task.workspaceId,
                buildId,
                namespace,
                limit,
              })
            : [];

        const results = raw
          .filter((entry) => !namespace || String(entry.preferredPath ?? entry.path ?? "").toLowerCase().startsWith(`${namespace}.`))
          .filter((entry) => isAllowed(entry.path, entry.approval))
          .slice(0, limit)
          .map((entry) => {
            const preferredPath = entry.preferredPath ?? entry.path;
            return {
              path: preferredPath,
              source: entry.source,
              approval: entry.approval,
              description: entry.description,
              input: normalizeHint(entry.displayInput, "{}"),
              output: normalizeHint(entry.displayOutput, "unknown"),
              // required keys are encoded in the `input` type hint
            };
          });

        return await finalizeImmediateTool({ results, total: results.length });
      }

      // discover
      const query = String(payload.query ?? "").trim();
      const limit = Math.max(1, Math.min(50, Number(payload.limit ?? 8)));
      const compact = payload.compact === false ? false : true;
      const hits = await searchRegistryTools(ctx, {
        workspaceId: task.workspaceId,
        buildId,
        query,
        limit: Math.max(limit * 2, limit),
      });

      const filtered = hits
        .filter((entry) => isAllowed(entry.path, entry.approval))
        .slice(0, limit);

      const results = filtered.map((entry) => {
        const preferredPath = entry.preferredPath ?? entry.path;
        const description = compact ? String(entry.description ?? "").split("\n")[0] : entry.description;
        return {
          path: preferredPath,
          source: entry.source,
          approval: entry.approval,
          description,
          input: normalizeHint(entry.displayInput, "{}"),
          output: normalizeHint(entry.displayOutput, "unknown"),
          // required keys are encoded in the `input` type hint
        };
      });

      const bestPath = results[0]?.path ?? null;
      return await finalizeImmediateTool({
        bestPath,
        results,
        total: results.length,
      });
    }

    const resolvedToolResult = await resolveToolForCall(ctx, task, toolPath);
    if (resolvedToolResult.isErr()) {
      throw resolvedToolResult.error;
    }
    const { tool, resolvedToolPath } = resolvedToolResult.value;

    let decision: PolicyDecision;
    effectiveToolPath = resolvedToolPath;
    if (tool._graphqlSource) {
      const result = getGraphqlDecision(task, tool, input, undefined, typedPolicies);
      decision = result.decision;
      if (result.effectivePaths.length > 0) {
        effectiveToolPath = result.effectivePaths.join(", ");
      }
    } else {
      decision = getToolDecision(task, tool, typedPolicies);
    }

    const publishToolStarted = persistedCall.status === "requested";

    if (decision === "deny") {
      const deniedMessage = `${effectiveToolPath} (policy denied)`;
      await denyToolCall(ctx, {
        task,
        callId,
        toolPath: effectiveToolPath,
        deniedMessage,
        reason: "policy_deny",
      });
    }

    let credential: ResolvedToolCredential | undefined;
    if (tool.credential) {
      const resolved = await resolveCredentialHeaders(ctx, tool.credential, task);
      if (!resolved) {
        throw new Error(`Missing credential for source '${tool.credential.sourceKey}' (${tool.credential.mode} scope)`);
      }
      credential = resolved;
    }

    if (publishToolStarted) {
      await publishTaskEvent(ctx, task.id, "task", "tool.call.started", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
        approval: decision === "require_approval" ? "required" : "auto",
      });
    }

    let approvalSatisfied = false;
    if (persistedCall.approvalId) {
      const existingApproval = await ctx.runQuery(internal.database.getApproval, {
        approvalId: persistedCall.approvalId,
      });
      if (!existingApproval) {
        throw new Error(`Approval ${persistedCall.approvalId} not found for call ${callId}`);
      }

      if (existingApproval.status === "pending") {
        throw new ToolCallControlError({
          kind: "approval_pending",
          approvalId: existingApproval.id,
        });
      }

      if (existingApproval.status === "denied") {
        await denyToolCallForApproval(ctx, {
          task,
          callId,
          toolPath: effectiveToolPath,
          approvalId: existingApproval.id,
        });
      }

      approvalSatisfied = existingApproval.status === "approved";
    }

    if (decision === "require_approval" && !approvalSatisfied) {
      const approvalId = persistedCall.approvalId ?? createApprovalId();
      let approval = await ctx.runQuery(internal.database.getApproval, {
        approvalId,
      });

      if (!approval) {
        approval = await ctx.runMutation(internal.database.createApproval, {
          id: approvalId,
          taskId: task.id,
          toolPath: effectiveToolPath,
          input,
        });

        await publishTaskEvent(ctx, task.id, "approval", "approval.requested", {
          approvalId: approval.id,
          taskId: task.id,
          callId,
          toolPath: approval.toolPath,
          input: asPayload(approval.input),
          createdAt: approval.createdAt,
        });
      }

      await ctx.runMutation(internal.database.setToolCallPendingApproval, {
        taskId: task.id,
        callId,
        approvalId: approval.id,
      });

      if (approval.status === "pending") {
        throw new ToolCallControlError({
          kind: "approval_pending",
          approvalId: approval.id,
        });
      }

      if (approval.status === "denied") {
        await denyToolCallForApproval(ctx, {
          task,
          callId,
          toolPath: effectiveToolPath,
          approvalId: approval.id,
        });
      }
    }

    const context: ToolRunContext = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      actorId: task.actorId,
      clientId: task.clientId,
      credential,
      // Tool visibility is enforced server-side; runtime tool implementations don't use this.
      isToolAllowed: (_path) => true,
    };
    const value = await tool.run(input, context);
    await completeToolCall(ctx, {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
    });
    return value;
  } catch (error) {
    const message = describeError(error);
    const controlSignal = decodeToolCallControlSignal(error);

    if (!controlSignal) {
      await failToolCall(ctx, {
        taskId: task.id,
        callId,
        error: message,
        toolPath: effectiveToolPath,
      });
    }

    throw error;
  }
}
