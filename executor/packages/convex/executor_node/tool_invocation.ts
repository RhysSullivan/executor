"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { resolveCredentialPayload } from "../../core/src/credential-providers";
import { APPROVAL_DENIED_PREFIX, APPROVAL_PENDING_PREFIX } from "../../core/src/execution-constants";
import { parseGraphqlOperationPaths } from "../../core/src/tool-sources";
import type {
  AccessPolicyRecord,
  CredentialScope,
  PolicyDecision,
  ResolvedToolCredential,
  TaskRecord,
  ToolCallRecord,
  ToolCallRequest,
  ToolCredentialSpec,
  ToolDefinition,
  ToolRunContext,
} from "../../core/src/types";
import { asPayload, describeError } from "../../core/src/utils";
import { getDecisionForContext, getToolDecision, isToolAllowedForTask } from "./policy";
import { resolveAliasedToolPath, suggestToolPaths } from "./tool_paths";
import { baseTools, getWorkspaceTools } from "./workspace_tools";
import { publishTaskEvent } from "./events";

function createApprovalId(): string {
  return `approval_${crypto.randomUUID()}`;
}

async function resolveCredentialHeaders(
  ctx: ActionCtx,
  spec: ToolCredentialSpec,
  task: TaskRecord,
): Promise<ResolvedToolCredential | null> {
  const record = await ctx.runQuery(internal.database.resolveCredential, {
    workspaceId: task.workspaceId,
    sourceKey: spec.sourceKey,
    scope: spec.mode as CredentialScope,
    actorId: task.actorId,
  });

  const source = record
    ? await resolveCredentialPayload(record)
    : spec.staticSecretJson ?? null;
  if (!source) {
    return null;
  }

  const headers: Record<string, string> = {};
  if (spec.authType === "bearer") {
    const token = String((source as Record<string, unknown>).token ?? "").trim();
    if (token) headers.authorization = `Bearer ${token}`;
  } else if (spec.authType === "apiKey") {
    const headerName = spec.headerName ?? String((source as Record<string, unknown>).headerName ?? "x-api-key");
    const value = String((source as Record<string, unknown>).value ?? (source as Record<string, unknown>).token ?? "").trim();
    if (value) headers[headerName] = value;
  } else if (spec.authType === "basic") {
    const username = String((source as Record<string, unknown>).username ?? "");
    const password = String((source as Record<string, unknown>).password ?? "");
    if (username || password) {
      const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
      headers.authorization = `Basic ${encoded}`;
    }
  }

  if (Object.keys(headers).length === 0) {
    const bindingOverrides = asPayload((record?.overridesJson as unknown) ?? {});
    const overrideHeaders = asPayload(bindingOverrides.headers);
    if (Object.keys(overrideHeaders).length === 0) {
      return null;
    }
    for (const [key, value] of Object.entries(overrideHeaders)) {
      if (!key) continue;
      headers[key] = String(value);
    }
  } else {
    const bindingOverrides = asPayload((record?.overridesJson as unknown) ?? {});
    const overrideHeaders = asPayload(bindingOverrides.headers);
    for (const [key, value] of Object.entries(overrideHeaders)) {
      if (!key) continue;
      headers[key] = String(value);
    }
  }

  return {
    sourceKey: spec.sourceKey,
    mode: spec.mode,
    headers,
  };
}

function getGraphqlDecision(
  task: TaskRecord,
  tool: ToolDefinition,
  input: unknown,
  workspaceTools: Map<string, ToolDefinition>,
  policies: AccessPolicyRecord[],
): { decision: PolicyDecision; effectivePaths: string[] } {
  const sourceName = tool._graphqlSource!;
  const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const queryString = typeof payload.query === "string" ? payload.query : "";

  if (!queryString.trim()) {
    return { decision: getToolDecision(task, tool, policies), effectivePaths: [tool.path] };
  }

  const { fieldPaths } = parseGraphqlOperationPaths(sourceName, queryString);
  if (fieldPaths.length === 0) {
    return { decision: getToolDecision(task, tool, policies), effectivePaths: [tool.path] };
  }

  let worstDecision: PolicyDecision = "allow";

  for (const fieldPath of fieldPaths) {
    const pseudoTool = workspaceTools.get(fieldPath);
    const fieldDecision = pseudoTool
      ? getDecisionForContext(
          pseudoTool,
          {
            workspaceId: task.workspaceId,
            actorId: task.actorId,
            clientId: task.clientId,
          },
          policies,
        )
      : getDecisionForContext(
          { ...tool, path: fieldPath, approval: fieldPath.includes(".mutation.") ? "required" : "auto" },
          {
            workspaceId: task.workspaceId,
            actorId: task.actorId,
            clientId: task.clientId,
          },
          policies,
        );

    if (fieldDecision === "deny") {
      worstDecision = "deny";
      break;
    }
    if (fieldDecision === "require_approval") {
      worstDecision = "require_approval";
    }
  }

  return { decision: worstDecision, effectivePaths: fieldPaths };
}

export async function invokeTool(ctx: ActionCtx, task: TaskRecord, call: ToolCallRequest): Promise<unknown> {
  const { toolPath, input, callId } = call;
  const persistedCall = (await ctx.runMutation(internal.database.upsertToolCallRequested, {
    taskId: task.id,
    callId,
    workspaceId: task.workspaceId,
    toolPath,
  })) as ToolCallRecord;

  if (persistedCall.status === "completed") {
    throw new Error(`Tool call ${callId} already completed; output is not retained`);
  }

  if (persistedCall.status === "failed") {
    throw new Error(persistedCall.error ?? `Tool call failed: ${callId}`);
  }

  if (persistedCall.status === "denied") {
    throw new Error(`${APPROVAL_DENIED_PREFIX}${persistedCall.error ?? persistedCall.toolPath}`);
  }

  const policies = await ctx.runQuery(internal.database.listAccessPolicies, { workspaceId: task.workspaceId });
  const typedPolicies = policies as AccessPolicyRecord[];

  let workspaceTools: Map<string, ToolDefinition> | undefined;
  let resolvedToolPath = toolPath;
  let tool = baseTools.get(toolPath);
  if (!tool) {
    const result = await getWorkspaceTools(ctx, task.workspaceId);
    workspaceTools = result.tools;
    tool = workspaceTools.get(toolPath);

    if (!tool) {
      const aliasedPath = resolveAliasedToolPath(toolPath, workspaceTools);
      if (aliasedPath) {
        resolvedToolPath = aliasedPath;
        tool = workspaceTools.get(aliasedPath);
      }
    }
  }

  if (!tool) {
    const availableTools = workspaceTools ?? baseTools;
    const suggestions = suggestToolPaths(toolPath, availableTools);
    const suggestionText = suggestions.length > 0
      ? `\nDid you mean: ${suggestions.map((path) => `tools.${path}`).join(", ")}`
      : "";
    throw new Error(`Unknown tool: ${toolPath}${suggestionText}`);
  }

  let decision: PolicyDecision;
  let effectiveToolPath = resolvedToolPath;
  if (tool._graphqlSource) {
    if (!workspaceTools) {
      const result = await getWorkspaceTools(ctx, task.workspaceId);
      workspaceTools = result.tools;
    }
    const result = getGraphqlDecision(task, tool, input, workspaceTools, typedPolicies);
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
    await ctx.runMutation(internal.database.finishToolCall, {
      taskId: task.id,
      callId,
      status: "denied",
      error: deniedMessage,
    });
    await publishTaskEvent(ctx, task.id, "task", "tool.call.denied", {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
      reason: "policy_deny",
    });
    throw new Error(`${APPROVAL_DENIED_PREFIX}${deniedMessage}`);
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
      const deniedMessage = `${effectiveToolPath} (${existingApproval.id})`;
      await ctx.runMutation(internal.database.finishToolCall, {
        taskId: task.id,
        callId,
        status: "denied",
        error: deniedMessage,
      });
      await publishTaskEvent(ctx, task.id, "task", "tool.call.denied", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
        approvalId: existingApproval.id,
      });
      throw new Error(`${APPROVAL_DENIED_PREFIX}${deniedMessage}`);
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
      const deniedMessage = `${effectiveToolPath} (${approval.id})`;
      await ctx.runMutation(internal.database.finishToolCall, {
        taskId: task.id,
        callId,
        status: "denied",
        error: deniedMessage,
      });
      await publishTaskEvent(ctx, task.id, "task", "tool.call.denied", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
        approvalId: approval.id,
      });
      throw new Error(`${APPROVAL_DENIED_PREFIX}${deniedMessage}`);
    }
  }

  try {
    const context: ToolRunContext = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      actorId: task.actorId,
      clientId: task.clientId,
      credential,
      isToolAllowed: (path) => isToolAllowedForTask(task, path, workspaceTools ?? baseTools, typedPolicies),
    };
    const value = await tool.run(input, context);
    await ctx.runMutation(internal.database.finishToolCall, {
      taskId: task.id,
      callId,
      status: "completed",
    });
    await publishTaskEvent(ctx, task.id, "task", "tool.call.completed", {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
      outputRedacted: true,
    });
    return value;
  } catch (error) {
    const message = describeError(error);
    await ctx.runMutation(internal.database.finishToolCall, {
      taskId: task.id,
      callId,
      status: "failed",
      error: message,
    });
    await publishTaskEvent(ctx, task.id, "task", "tool.call.failed", {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
      error: message,
    });
    throw error;
  }
}
