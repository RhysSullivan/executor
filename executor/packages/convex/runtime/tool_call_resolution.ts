"use node";

import type { ActionCtx } from "../_generated/server";
import { parseGraphqlOperationPaths } from "../../core/src/graphql-operation-paths";
import type { AccessPolicyRecord, PolicyDecision, TaskRecord, ToolDefinition } from "../../core/src/types";
import { getDecisionForContext, getToolDecision } from "./policy";
import { resolveAliasedToolPath, resolveClosestToolPath, suggestToolPaths, toPreferredToolPath } from "./tool_paths";
import { baseTools, getWorkspaceTools } from "./workspace_tools";

export function getGraphqlDecision(
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

function unknownToolErrorMessage(toolPath: string, availableTools: Map<string, ToolDefinition>): string {
  const suggestions = suggestToolPaths(toolPath, availableTools);
  const queryHint = toolPath
    .split(".")
    .filter(Boolean)
    .join(" ");
  const suggestionText = suggestions.length > 0
    ? `\nDid you mean: ${suggestions.map((path) => `tools.${toPreferredToolPath(path)}`).join(", ")}`
    : "";
  const discoverHint = `\nTry: const found = await tools.discover({ query: "${queryHint}", compact: false, depth: 2, limit: 12 });`;
  return `Unknown tool: ${toolPath}${suggestionText}${discoverHint}`;
}

export async function ensureWorkspaceTools(
  ctx: ActionCtx,
  task: TaskRecord,
  workspaceTools?: Map<string, ToolDefinition>,
): Promise<Map<string, ToolDefinition>> {
  if (workspaceTools) {
    return workspaceTools;
  }
  const result = await getWorkspaceTools(ctx, task.workspaceId, {
    actorId: task.actorId,
  });
  return result.tools;
}

export async function resolveToolForCall(
  ctx: ActionCtx,
  task: TaskRecord,
  toolPath: string,
): Promise<{
  tool: ToolDefinition;
  resolvedToolPath: string;
  workspaceTools?: Map<string, ToolDefinition>;
}> {
  let workspaceTools: Map<string, ToolDefinition> | undefined;
  let resolvedToolPath = toolPath;
  let tool = baseTools.get(toolPath);
  if (!tool) {
    workspaceTools = await ensureWorkspaceTools(ctx, task, workspaceTools);
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
    const healedPath = resolveClosestToolPath(toolPath, availableTools);
    if (healedPath) {
      resolvedToolPath = healedPath;
      tool = availableTools.get(healedPath);
    }
  }

  if (!tool) {
    const availableTools = workspaceTools ?? baseTools;
    throw new Error(unknownToolErrorMessage(toolPath, availableTools));
  }

  return {
    tool,
    resolvedToolPath,
    workspaceTools,
  };
}
