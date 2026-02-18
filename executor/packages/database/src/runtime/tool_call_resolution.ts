import { Result } from "better-result";
import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { parseGraphqlOperationPaths } from "../../../core/src/graphql/operation-paths";
import type { ToolPolicyRecord, PolicyDecision, TaskRecord, ToolDefinition } from "../../../core/src/types";
import { parseSerializedTool, type SerializedTool } from "../../../core/src/tool/source-serialization";
import { getDecisionForContext, getToolDecision } from "./policy";
import { getReadyRegistryBuildIdResult } from "./tool_registry_state";
import { normalizeToolPathForLookup, toPreferredToolPath } from "./tool_paths";
import { baseTools } from "./base_tools";

type RegistrySerializedToolEntry = {
  path: string;
  serializedToolJson: string;
};

const registrySearchEntrySchema = z.object({
  preferredPath: z.string(),
});

const registrySerializedToolEntrySchema = z.object({
  path: z.string(),
  serializedToolJson: z.string(),
});

const graphqlDecisionInputSchema = z.union([
  z.string(),
  z.object({ query: z.string().optional() }).catchall(z.unknown()),
]);

function getGraphqlQueryFromInput(input: unknown): string {
  const parsedInput = graphqlDecisionInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return "";
  }

  if (typeof parsedInput.data === "string") {
    return parsedInput.data;
  }

  return parsedInput.data.query ?? "";
}

async function searchRegistryEntries(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; query: string; limit: number },
): Promise<Array<{ preferredPath: string }>> {
  const entries = await ctx.runQuery(internal.toolRegistry.searchTools, args);
  const parsed = z.array(registrySearchEntrySchema).safeParse(entries);
  return parsed.success ? parsed.data : [];
}

async function getRegistryToolByPath(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; path: string },
): Promise<RegistrySerializedToolEntry | null> {
  const entry = await ctx.runQuery(internal.toolRegistry.getToolByPath, args);
  const parsed = registrySerializedToolEntrySchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

async function getRegistryToolsByNormalizedPath(
  ctx: ActionCtx,
  args: {
    workspaceId: TaskRecord["workspaceId"];
    buildId: string;
    normalizedPath: string;
    limit: number;
  },
): Promise<RegistrySerializedToolEntry[]> {
  const entries = await ctx.runQuery(internal.toolRegistry.getToolsByNormalizedPath, args);
  const parsed = z.array(registrySerializedToolEntrySchema).safeParse(entries);
  return parsed.success ? parsed.data : [];
}

export function getGraphqlDecision(
  task: TaskRecord,
  tool: { path: string; approval: "auto" | "required"; source?: string; _graphqlSource?: string },
  input: unknown,
  workspaceTools: Map<string, { path: string; approval: "auto" | "required"; source?: string }> | undefined,
  policies: ToolPolicyRecord[],
): { decision: PolicyDecision; effectivePaths: string[] } {
  const sourceName = tool._graphqlSource;
  if (!sourceName) {
    return { decision: getToolDecision(task, tool, policies), effectivePaths: [tool.path] };
  }

  const queryString = getGraphqlQueryFromInput(input);

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
            accountId: task.accountId,
            clientId: task.clientId,
          },
          policies,
        )
      : getDecisionForContext(
          {
            ...tool,
            path: fieldPath,
            approval: fieldPath.includes(".mutation.") ? "required" : "auto",
          },
          {
            workspaceId: task.workspaceId,
            accountId: task.accountId,
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
  const hits = await searchRegistryEntries(ctx, {
    workspaceId,
    buildId,
    query: term,
    limit: 3,
  });
  return hits.map((hit) => hit.preferredPath);
}

function unknownToolErrorMessage(toolPath: string, suggestions: string[]): string {
  const suggestionText = suggestions.length > 0
    ? `\nDid you mean: ${suggestions.map((path) => `tools.${path}`).join(", ")}`
    : "";
  const queryHint = toolPath.split(".").filter(Boolean).join(" ");
  const discoverHint = `\nTry: const found = await tools.discover({ query: "${queryHint}", depth: 1, limit: 12 });`;
  return `Unknown tool: ${toolPath}${suggestionText}${discoverHint}`;
}

export async function resolveToolForCall(
  ctx: ActionCtx,
  task: TaskRecord,
  toolPath: string,
): Promise<Result<
  | {
      tool: ToolDefinition;
      kind: "builtin";
      resolvedToolPath: string;
    }
  | {
      tool: SerializedTool;
      kind: "serialized";
      resolvedToolPath: string;
    },
  Error
>> {
  const builtin = baseTools.get(toolPath);
  if (builtin) {
    return Result.ok({ kind: "builtin", tool: builtin, resolvedToolPath: toolPath });
  }

  const buildIdResult = await getReadyRegistryBuildIdResult(ctx, {
    workspaceId: task.workspaceId,
    accountId: task.accountId,
    clientId: task.clientId,
  });
  if (buildIdResult.isErr()) {
    return Result.err(buildIdResult.error);
  }
  const buildId = buildIdResult.value;

  let resolvedToolPath = toolPath;
  let entry = await getRegistryToolByPath(ctx, {
    workspaceId: task.workspaceId,
    buildId,
    path: toolPath,
  });

  if (!entry) {
    const normalized = normalizeToolPathForLookup(toolPath);
    const hits = await getRegistryToolsByNormalizedPath(ctx, {
      workspaceId: task.workspaceId,
      buildId,
      normalizedPath: normalized,
      limit: 5,
    });

    if (hits.length > 0) {
      // Prefer exact match on preferred path formatting, otherwise shortest canonical path.
      const exact = hits.find((hit) => toPreferredToolPath(hit.path) === toPreferredToolPath(toolPath));
      const shortest = [...hits]
        .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))[0];
      entry = exact ?? shortest ?? null;
      if (entry) {
        resolvedToolPath = entry.path;
      }
    }
  }

  if (!entry) {
    const suggestions = await suggestFromRegistry(ctx, task.workspaceId, buildId, toolPath);
    return Result.err(new Error(unknownToolErrorMessage(toolPath, suggestions)));
  }

  let parsedSerialized: unknown;
  try {
    parsedSerialized = JSON.parse(entry.serializedToolJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Result.err(
      new Error(`Failed to parse tool registry entry '${resolvedToolPath}': ${message}`),
    );
  }
  const serialized = parseSerializedTool(parsedSerialized);
  if (serialized.isErr()) {
    return Result.err(
      new Error(`Failed to parse tool registry entry '${resolvedToolPath}': ${serialized.error.message}`),
    );
  }

  return Result.ok({ kind: "serialized", tool: serialized.value, resolvedToolPath });
}
