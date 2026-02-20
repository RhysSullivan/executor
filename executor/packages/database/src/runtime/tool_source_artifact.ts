import { Result } from "better-result";
import { z } from "zod";
import { parseSerializedTool, rehydrateTools, type SerializedTool } from "../../../core/src/tool/source-serialization";
import type { ToolDefinition } from "../../../core/src/types";

const compiledToolSourceArtifactSchema = z.object({
  version: z.literal("v1"),
  sourceType: z.enum(["mcp", "openapi", "graphql"]),
  sourceName: z.string(),
  openApiSourceKey: z.string().optional(),
  openApiRefHintTable: z.record(z.string()).optional(),
  tools: z.array(z.unknown()),
});

type CompiledToolSourceArtifactEnvelope = z.infer<typeof compiledToolSourceArtifactSchema>;

export type CompiledToolSourceArtifact = Omit<CompiledToolSourceArtifactEnvelope, "tools"> & {
  tools: SerializedTool[];
};

export function parseCompiledToolSourceArtifact(value: unknown): Result<CompiledToolSourceArtifact, Error> {
  const parsedValue = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch (error) {
          return error;
        }
      })()
    : value;

  if (parsedValue instanceof Error) {
    return Result.err(new Error(`Invalid compiled tool source artifact JSON: ${parsedValue.message}`));
  }

  const parsedArtifact = compiledToolSourceArtifactSchema.safeParse(parsedValue);
  if (!parsedArtifact.success) {
    return Result.err(new Error(parsedArtifact.error.message));
  }

  const tools: SerializedTool[] = [];
  for (const tool of parsedArtifact.data.tools) {
    const parsedTool = parseSerializedTool(tool);
    if (parsedTool.isErr()) {
      return Result.err(new Error(`Invalid serialized tool in artifact '${parsedArtifact.data.sourceName}': ${parsedTool.error.message}`));
    }
    tools.push(parsedTool.value);
  }

  return Result.ok({
    ...parsedArtifact.data,
    tools,
  });
}

export function materializeCompiledToolSource(artifact: CompiledToolSourceArtifact): ToolDefinition[] {
  return rehydrateTools(artifact.tools, new Map());
}
