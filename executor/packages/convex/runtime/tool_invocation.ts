"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { APPROVAL_PENDING_PREFIX } from "../../core/src/execution-constants";
import type {
  AccessPolicyRecord,
  PolicyDecision,
  ResolvedToolCredential,
  TaskRecord,
  ToolDefinition,
  ToolCallRecord,
  ToolCallRequest,
  ToolRunContext,
} from "../../core/src/types";
import { describeError } from "../../core/src/utils";
import { asPayload } from "../lib/object";
import { getToolDecision, getDecisionForContext } from "./policy";
import { baseTools } from "./workspace_tools";
import { publishTaskEvent } from "./events";
import { completeToolCall, denyToolCall, failToolCall } from "./tool_call_lifecycle";
import { assertPersistedCallRunnable, resolveCredentialHeaders } from "./tool_call_credentials";
import { getGraphqlDecision, resolveToolForCall } from "./tool_call_resolution";
import { sourceSignature } from "./tool_source_loading";

function createApprovalId(): string {
  return `approval_${crypto.randomUUID()}`;
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
  const persistedCall = (await ctx.runMutation(internal.database.upsertToolCallRequested, {
    taskId: task.id,
    callId,
    workspaceId: task.workspaceId,
    toolPath,
  })) as ToolCallRecord;
  assertPersistedCallRunnable(persistedCall, callId);

  const policies = await ctx.runQuery(internal.database.listAccessPolicies, { workspaceId: task.workspaceId });
  const typedPolicies = policies as AccessPolicyRecord[];

  // Fast system tools are handled server-side from the registry.
  if (toolPath === "discover" || toolPath === "catalog.namespaces" || toolPath === "catalog.tools") {
    const toolRegistry = internal.toolRegistry;
    const [state, sources] = await Promise.all([
      ctx.runQuery(toolRegistry.getState, { workspaceId: task.workspaceId }) as Promise<null | { signature: string; readyBuildId?: string }>,
      ctx.runQuery(internal.database.listToolSources, { workspaceId: task.workspaceId }) as Promise<Array<{ id: string; updatedAt: number; enabled: boolean }>>,
    ]);
    const enabledSources = sources.filter((source) => source.enabled);
    const signature = sourceSignature(task.workspaceId, enabledSources);
    const expectedSignature = `toolreg_v2|${signature}`;
    const buildId = state?.readyBuildId;
    if (!buildId || state.signature !== expectedSignature) {
      throw new Error(
        "Tool registry is not ready (or is stale). Open Tools to refresh, or call listToolsWithWarnings to rebuild.",
      );
    }

    const payload = typeof input === "string"
      ? { query: input }
      : (input && typeof input === "object" ? (input as Record<string, unknown>) : {});
    const isAllowed = (path: string, approval: ToolDefinition["approval"]) =>
      getDecisionForContext(
        { path, approval, description: "", run: async () => null } as ToolDefinition,
        { workspaceId: task.workspaceId, actorId: task.actorId, clientId: task.clientId },
        typedPolicies,
      ) !== "deny";

    const normalizeHint = (value: unknown, fallback: string) => {
      const str = typeof value === "string" ? value.trim() : "";
      return str.length > 0 ? str : fallback;
    };

    if (toolPath === "catalog.namespaces") {
      const limit = Math.max(1, Math.min(200, Number(payload.limit ?? 200)));
      const namespaces = await ctx.runQuery(toolRegistry.listNamespaces, {
        workspaceId: task.workspaceId,
        buildId,
        limit,
      }) as Array<{ namespace: string; toolCount: number; samplePaths: string[] }>;
      return { namespaces, total: namespaces.length };
    }

    if (toolPath === "catalog.tools") {
      const namespace = String(payload.namespace ?? "").trim().toLowerCase();
      const query = String(payload.query ?? "").trim();
      const limit = Math.max(1, Math.min(200, Number(payload.limit ?? 50)));

      const raw = query
        ? await ctx.runQuery(toolRegistry.searchTools, {
            workspaceId: task.workspaceId,
            buildId,
            query,
            limit,
          })
        : namespace
          ? await ctx.runQuery(toolRegistry.listToolsByNamespace, {
              workspaceId: task.workspaceId,
              buildId,
              namespace,
              limit,
            })
          : [];

      const results = (raw as Array<any>)
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

      return { results, total: results.length };
    }

    // discover
    const query = String(payload.query ?? "").trim();
    const limit = Math.max(1, Math.min(50, Number(payload.limit ?? 8)));
    const compact = payload.compact === false ? false : true;
    const hits = await ctx.runQuery(toolRegistry.searchTools, {
      workspaceId: task.workspaceId,
      buildId,
      query,
      limit: Math.max(limit * 2, limit),
    }) as Array<any>;

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
    return {
      bestPath,
      results,
      total: results.length,
    };
  }

  let { tool, resolvedToolPath } = await resolveToolForCall(ctx, task, toolPath);

  let decision: PolicyDecision;
  let effectiveToolPath = resolvedToolPath;
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
      throw new Error(`${APPROVAL_PENDING_PREFIX}${existingApproval.id}`);
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
      throw new Error(`${APPROVAL_PENDING_PREFIX}${approval.id}`);
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

  try {
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
    await failToolCall(ctx, {
      taskId: task.id,
      callId,
      error: message,
      toolPath: effectiveToolPath,
    });
    throw error;
  }
}
