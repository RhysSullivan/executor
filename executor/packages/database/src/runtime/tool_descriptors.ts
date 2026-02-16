"use node";

import type {
  AccessPolicyRecord,
  OpenApiSourceQuality,
  ToolDefinition,
  ToolDescriptor,
} from "../../../core/src/types";
import { jsonSchemaTypeHintFallback } from "../../../core/src/openapi/schema-hints";
import { buildPreviewKeys, extractTopLevelRequiredKeys } from "../../../core/src/tool-typing/schema-utils";
import { getDecisionForContext } from "./policy";

function toToolDescriptor(
  tool: ToolDefinition,
  approval: "auto" | "required",
  options: { includeDetails?: boolean } = {},
): ToolDescriptor {
  const includeDetails = options.includeDetails ?? true;

  return {
    path: tool.path,
    description: includeDetails ? tool.description : "",
    approval,
    source: tool.source,
    ...(includeDetails
      ? {
          typing: tool.typing
            ? {
                requiredInputKeys: tool.typing.requiredInputKeys
                  ?? extractTopLevelRequiredKeys(tool.typing.inputSchema),
                previewInputKeys: tool.typing.previewInputKeys
                  ?? buildPreviewKeys(tool.typing.inputSchema),
                typedRef: tool.typing.typedRef,
              }
            : undefined,
          display: {
            input: tool.typing?.inputSchema
              ? (Object.keys(tool.typing.inputSchema).length === 0 ? "{}" : jsonSchemaTypeHintFallback(tool.typing.inputSchema))
              : "{}",
            output: tool.typing?.outputSchema
              ? (Object.keys(tool.typing.outputSchema).length === 0 ? "unknown" : jsonSchemaTypeHintFallback(tool.typing.outputSchema))
              : "unknown",
          },
        }
      : {}),
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
      const inputSchema = tool.typing?.inputSchema ?? {};
      const outputSchema = tool.typing?.outputSchema ?? {};
      const hasInput = Object.keys(inputSchema).length > 0;
      const hasOutput = Object.keys(outputSchema).length > 0;
      if (!hasInput) unknownArgsCount += 1;
      if (!hasOutput) unknownReturnsCount += 1;
      // Best-effort: count schema nodes that still include unknown-ish placeholders.
      const inputHint = hasInput ? jsonSchemaTypeHintFallback(inputSchema) : "unknown";
      const outputHint = hasOutput ? jsonSchemaTypeHintFallback(outputSchema) : "unknown";
      if (inputHint.includes("unknown")) partialUnknownArgsCount += 1;
      if (outputHint.includes("unknown")) partialUnknownReturnsCount += 1;
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
  options: { includeDetails?: boolean; toolPaths?: string[] } = {},
): ToolDescriptor[] {
  const requestedPaths = options.toolPaths ?? [];
  let candidates: ToolDefinition[];

  if (requestedPaths.length > 0) {
    const seen = new Set<string>();
    const selected: ToolDefinition[] = [];
    for (const path of requestedPaths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const tool = workspaceTools.get(path);
      if (tool) selected.push(tool);
    }
    candidates = selected;
  } else {
    candidates = [...workspaceTools.values()];
  }

  return candidates
    .filter((tool) => {
      const decision = getDecisionForContext(tool, context, policies);
      return decision !== "deny";
    })
    .map((tool) => {
      const decision = getDecisionForContext(tool, context, policies);
      return toToolDescriptor(tool, decision === "require_approval" ? "required" : "auto", options);
    });
}
