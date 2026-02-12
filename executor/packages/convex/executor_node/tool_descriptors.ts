"use node";

import type {
  AccessPolicyRecord,
  OpenApiSourceQuality,
  ToolDefinition,
  ToolDescriptor,
} from "../../core/src/types";
import { getDecisionForContext } from "./policy";

function toToolDescriptor(tool: ToolDefinition, approval: "auto" | "required"): ToolDescriptor {
  return {
    path: tool.path,
    description: tool.description,
    approval,
    source: tool.source,
    argsType: tool.metadata?.displayArgsType ?? tool.metadata?.argsType,
    returnsType: tool.metadata?.displayReturnsType ?? tool.metadata?.returnsType,
    strictArgsType: tool.metadata?.argsType,
    strictReturnsType: tool.metadata?.returnsType,
    argPreviewKeys: tool.metadata?.argPreviewKeys,
    operationId: tool.metadata?.operationId,
  };
}

export function computeOpenApiSourceQuality(
  workspaceTools: Map<string, ToolDefinition>,
): Record<string, OpenApiSourceQuality> {
  const grouped = new Map<string, ToolDefinition[]>();

  for (const tool of workspaceTools.values()) {
    const sourceKey = tool.source;
    if (!sourceKey || !sourceKey.startsWith("openapi:")) continue;
    const list = grouped.get(sourceKey) ?? [];
    list.push(tool);
    grouped.set(sourceKey, list);
  }

  const qualityBySource: Record<string, OpenApiSourceQuality> = {};

  for (const [sourceKey, tools] of grouped.entries()) {
    const toolCount = tools.length;

    let unknownArgsCount = 0;
    let unknownReturnsCount = 0;
    let partialUnknownArgsCount = 0;
    let partialUnknownReturnsCount = 0;

    for (const tool of tools) {
      const argsType = tool.metadata?.argsType?.trim() ?? "";
      const returnsType = tool.metadata?.returnsType?.trim() ?? "";

      if (!argsType || argsType === "Record<string, unknown>") {
        unknownArgsCount += 1;
      }
      if (!returnsType || returnsType === "unknown") {
        unknownReturnsCount += 1;
      }
      if (argsType.includes("unknown")) {
        partialUnknownArgsCount += 1;
      }
      if (returnsType.includes("unknown")) {
        partialUnknownReturnsCount += 1;
      }
    }

    const argsQuality = toolCount > 0 ? (toolCount - unknownArgsCount) / toolCount : 1;
    const returnsQuality = toolCount > 0 ? (toolCount - unknownReturnsCount) / toolCount : 1;
    const overallQuality = (argsQuality + returnsQuality) / 2;

    qualityBySource[sourceKey] = {
      sourceKey,
      toolCount,
      unknownArgsCount,
      unknownReturnsCount,
      partialUnknownArgsCount,
      partialUnknownReturnsCount,
      argsQuality,
      returnsQuality,
      overallQuality,
    };
  }

  return qualityBySource;
}

export function listVisibleToolDescriptors(
  workspaceTools: Map<string, ToolDefinition>,
  context: { workspaceId: string; actorId?: string; clientId?: string },
  policies: AccessPolicyRecord[],
): ToolDescriptor[] {
  const all = [...workspaceTools.values()];

  return all
    .filter((tool) => {
      const decision = getDecisionForContext(tool, context, policies);
      return decision !== "deny";
    })
    .map((tool) => {
      const decision = getDecisionForContext(tool, context, policies);
      return toToolDescriptor(tool, decision === "require_approval" ? "required" : "auto");
    });
}
