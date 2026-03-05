import { tool } from "ai";
import type { ToolSet } from "ai";
import * as Effect from "effect/Effect";
import { z } from "zod";

import {
  createToolsFromRecord,
  executeCodeWithTools,
  type CodeExecutor,
  type CodeToolOutput,
  type ExecutableTool,
  type OnElicitation,
  type OnToolInteraction,
  type ToolMap,
} from "@executor-v3/codemode-core";

export {
  allowAllToolInteractions,
  buildExecuteDescription,
  createDiscoveryPrimitives,
  createDynamicDiscovery,
  createStaticDiscoveryFromTools,
  createSystemToolMap,
  executeCodeWithTools,
  makeToolInvokerFromTools,
  mergeToolMaps,
  toExecutorTool,
  toTool,
  ToolInteractionDeniedError,
  ToolInteractionPendingError,
  toolDescriptorsFromTools,
  wrapTool,
  type CatalogPrimitive,
  type CodeExecutor,
  type CodeToolOutput,
  type CreateSystemToolMapInput,
  type DescribePrimitive,
  type DiscoverPrimitive,
  type DiscoveryPrimitives,
  type ExecuteResult,
  type ExecutableTool,
  type MergeToolMapsOptions,
  type SearchHit,
  type SearchProvider,
  type StandardSchema,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolDirectory,
  type ToolInput,
  type OnElicitation,
  type OnToolInteraction,
  type ToolInvocationInput,
  type ToolInvoker,
  type ToolMap,
  type ToolMetadata,
  type ToolPath,
} from "@executor-v3/codemode-core";

export type AiSdkToolMap = ToolSet;

export const CodeToolInputSchema = z.object({
  code: z.string(),
});

export type CodeToolInput = z.infer<typeof CodeToolInputSchema>;

export function createToolsFromAiSdkTools(input: {
  tools: AiSdkToolMap;
  sourceKey?: string;
}): ToolMap {
  return createToolsFromRecord({
    tools: input.tools as Record<string, ExecutableTool>,
    sourceKey: input.sourceKey,
  });
}

export function createCodeTool(input: {
  tools: ToolMap;
  executor: CodeExecutor;
  onToolInteraction?: OnToolInteraction;
  onElicitation?: OnElicitation;
  description?: string;
}) {
  return tool({
    description:
      input.description
      ?? [
        "Write JavaScript and run it against tools.",
        "Use `await tools.<path>(input)` for tool calls.",
      ].join("\n"),
    inputSchema: CodeToolInputSchema,
    execute: ({ code }: CodeToolInput): Promise<CodeToolOutput> =>
      Effect.runPromise(
        executeCodeWithTools({
          code,
          tools: input.tools,
          executor: input.executor,
          onToolInteraction: input.onToolInteraction,
          onElicitation: input.onElicitation,
        }),
      ),
  });
}
