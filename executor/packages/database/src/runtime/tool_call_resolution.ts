"use node";

import { Result } from "better-result";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { parseGraphqlOperationPaths } from "../../../core/src/graphql/operation-paths";
import type { AccessPolicyRecord, PolicyDecision, TaskRecord, ToolDefinition } from "../../../core/src/types";
import { rehydrateTools, type SerializedTool } from "../../../core/src/tool/source-serialization";
import { asPayload } from "../lib/object";
import { getDecisionForContext, getToolDecision } from "./policy";
import { getReadyRegistryBuildId } from "./tool_registry_state";
import { normalizeToolPathForLookup, toPreferredToolPath } from "./tool_paths";
import { baseTools } from "./workspace_tools";

export function getGraphqlDecision(
  task: TaskRecord,
  tool: ToolDefinition,
  input: unknown,
  workspaceTools: Map<string, ToolDefinition> | undefined,
  policies: AccessPolicyRecord[],
): { decision: PolicyDecision; effectivePaths: string[] } {
  const sourceName = tool._graphqlSource!;
  const payload = asPayload(input);
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
    const pseudoTool = workspaceTools?.get(fieldPath);
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

async function suggestFromRegistry(
  ctx: ActionCtx,
  workspaceId: TaskRecord["workspaceId"],
  buildId: string,
  toolPath: string,
): Promise<string[]> {
  const term = toolPath.split(".").filter(Boolean).join(" ");
  const hits = await ctx.runQuery(internal.toolRegistry.searchTools, {
    workspaceId,
    buildId,
    query: term,
    limit: 3,
  }) as Array<{ preferredPath: string }>;
  return hits.map((hit) => hit.preferredPath);
}

function unknownToolErrorMessage(toolPath: string, suggestions: string[]): string {
  const suggestionText = suggestions.length > 0
    ? `\nDid you mean: ${suggestions.map((path) => `tools.${path}`).join(", ")}`
    : "";
  const queryHint = toolPath.split(".").filter(Boolean).join(" ");
  const discoverHint = `\nTry: const found = await tools.discover({ query: "${queryHint}", compact: true, depth: 1, limit: 12 });`;
  return `Unknown tool: ${toolPath}${suggestionText}${discoverHint}`;
}

export async function resolveToolForCall(
  ctx: ActionCtx,
  task: TaskRecord,
  toolPath: string,
): Promise<Result<{
  tool: ToolDefinition;
  resolvedToolPath: string;
}, Error>> {
  const builtin = baseTools.get(toolPath);
  if (builtin) {
    return Result.ok({ tool: builtin, resolvedToolPath: toolPath });
  }

  const buildId = await getReadyRegistryBuildId(ctx, {
    workspaceId: task.workspaceId,
    actorId: task.actorId,
    clientId: task.clientId,
    refreshOnStale: true,
  });

  let resolvedToolPath = toolPath;
  let entry = await ctx.runQuery(internal.toolRegistry.getToolByPath, {
    workspaceId: task.workspaceId,
    buildId,
    path: toolPath,
  }) as null | { path: string; serializedToolJson: string };

  if (!entry) {
    const normalized = normalizeToolPathForLookup(toolPath);
    const hits = await ctx.runQuery(internal.toolRegistry.getToolsByNormalizedPath, {
      workspaceId: task.workspaceId,
      buildId,
      normalizedPath: normalized,
      limit: 5,
    }) as Array<{ path: string; serializedToolJson: string }>;

    if (hits.length > 0) {
      // Prefer exact match on preferred path formatting, otherwise shortest canonical path.
      const exact = hits.find((hit) => toPreferredToolPath(hit.path) === toPreferredToolPath(toolPath));
      entry = exact ?? hits.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))[0]!;
      resolvedToolPath = entry.path;
    }
  }

  if (!entry) {
    const suggestions = await suggestFromRegistry(ctx, task.workspaceId, buildId, toolPath);
    return Result.err(new Error(unknownToolErrorMessage(toolPath, suggestions)));
  }

  const serializedResult = Result.try(() => JSON.parse(entry.serializedToolJson) as SerializedTool);
  if (serializedResult.isErr()) {
    return Result.err(
      new Error(`Failed to parse tool registry entry '${resolvedToolPath}': ${serializedResult.error.message}`),
    );
  }
  const serialized = serializedResult.value;
  const [tool] = rehydrateTools([serialized], baseTools);
  if (!tool) {
    return Result.err(new Error(`Failed to rehydrate tool: ${resolvedToolPath}`));
  }

  return Result.ok({ tool, resolvedToolPath });
}
