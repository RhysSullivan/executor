import { Result } from "better-result";
import { z } from "zod";
import {
  parseSerializedTool,
  rehydrateTools,
  type SerializedTool,
} from "../../../core/src/tool/source-serialization";
import type { ToolDefinition } from "../../../core/src/types";

export interface CompiledToolSourceArtifact {
  version: "v1";
  sourceType: "mcp" | "openapi" | "graphql";
  sourceName: string;
  openApiSourceKey?: string;
  openApiRefHintTable?: Record<string, string>;
  tools: SerializedTool[];
}

const compiledToolSourceArtifactSchema = z.object({
  version: z.literal("v1"),
  sourceType: z.enum(["mcp", "openapi", "graphql"]),
  sourceName: z.string(),
  openApiSourceKey: z.string().optional(),
  openApiRefHintTable: z.record(z.string()).optional(),
  tools: z.array(z.unknown()),
});

export function parseCompiledToolSourceArtifact(value: unknown): Result<CompiledToolSourceArtifact, Error> {
  const parsedArtifact = compiledToolSourceArtifactSchema.safeParse(value);
  if (!parsedArtifact.success) {
    return Result.err(new Error(parsedArtifact.error.message));
  }

  const tools: SerializedTool[] = [];
  for (const tool of parsedArtifact.data.tools) {
    const parsedTool = parseSerializedTool(tool);
    if (parsedTool.isErr()) {
      return Result.err(
        new Error(`Invalid serialized tool in artifact '${parsedArtifact.data.sourceName}': ${parsedTool.error.message}`),
      );
    }
    tools.push(parsedTool.value);
  }

  return Result.ok({
    version: parsedArtifact.data.version,
    sourceType: parsedArtifact.data.sourceType,
    sourceName: parsedArtifact.data.sourceName,
    openApiSourceKey: parsedArtifact.data.openApiSourceKey,
    openApiRefHintTable: parsedArtifact.data.openApiRefHintTable,
    tools,
  });
}

export function materializeCompiledToolSource(artifact: CompiledToolSourceArtifact): ToolDefinition[] {
  return rehydrateTools(artifact.tools, new Map());
}
