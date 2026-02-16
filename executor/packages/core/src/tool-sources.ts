"use node";

import { Result } from "better-result";
import { z } from "zod";
import { loadGraphqlTools } from "./tool-source-loaders/graphql-loader";
import { loadMcpTools } from "./tool-source-loaders/mcp-loader";
import { loadOpenApiTools } from "./tool-source-loaders/openapi-loader";
import { buildOpenApiToolsFromPrepared } from "./openapi/tool-builder";
import { parseSerializedTool, rehydrateTools, serializeTools, type SerializedTool } from "./tool/source-serialization";
import type {
  ExternalToolSourceConfig,
  OpenApiToolSourceConfig,
  PreparedOpenApiSpec,
} from "./tool/source-types";
import type { ToolDefinition } from "./types";

export type {
  ExternalToolSourceConfig,
  GraphqlToolSourceConfig,
  McpToolSourceConfig,
  OpenApiAuth,
  OpenApiToolSourceConfig,
  PreparedOpenApiSpec,
} from "./tool/source-types";
export { prepareOpenApiSpec } from "./openapi-prepare";
export { parseGraphqlOperationPaths } from "./graphql/operation-paths";
export { rehydrateTools, serializeTools, type SerializedTool } from "./tool/source-serialization";
export { buildOpenApiToolsFromPrepared } from "./openapi/tool-builder";

export interface CompiledToolSourceArtifact {
  version: "v1";
  sourceType: ExternalToolSourceConfig["type"];
  sourceName: string;
  tools: SerializedTool[];
}

const compiledToolSourceArtifactSchema = z.object({
  version: z.literal("v1"),
  sourceType: z.enum(["mcp", "openapi", "graphql"]),
  sourceName: z.string(),
  tools: z.array(z.unknown()),
});

const workspaceToolSnapshotSchema = z.object({
  version: z.literal("v2"),
  externalArtifacts: z.array(z.unknown()),
  warnings: z.array(z.string()),
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
      return Result.err(new Error(`Invalid serialized tool in artifact '${parsedArtifact.data.sourceName}': ${parsedTool.error.message}`));
    }
    tools.push(parsedTool.value);
  }

  return Result.ok({
    version: parsedArtifact.data.version,
    sourceType: parsedArtifact.data.sourceType,
    sourceName: parsedArtifact.data.sourceName,
    tools,
  });
}

export function parseWorkspaceToolSnapshot(value: unknown): Result<WorkspaceToolSnapshot, Error> {
  const parsedSnapshot = workspaceToolSnapshotSchema.safeParse(value);
  if (!parsedSnapshot.success) {
    return Result.err(new Error(parsedSnapshot.error.message));
  }

  const externalArtifacts: CompiledToolSourceArtifact[] = [];
  for (const artifact of parsedSnapshot.data.externalArtifacts) {
    const parsedArtifact = parseCompiledToolSourceArtifact(artifact);
    if (parsedArtifact.isErr()) {
      return Result.err(new Error(`Invalid workspace snapshot artifact: ${parsedArtifact.error.message}`));
    }
    externalArtifacts.push(parsedArtifact.value);
  }

  return Result.ok({
    version: parsedSnapshot.data.version,
    externalArtifacts,
    warnings: parsedSnapshot.data.warnings,
  });
}

async function loadSourceToolDefinitions(source: ExternalToolSourceConfig): Promise<ToolDefinition[]> {
  if (source.type === "mcp") {
    return await loadMcpTools(source);
  }
  if (source.type === "openapi") {
    return await loadOpenApiTools(source);
  }
  if (source.type === "graphql") {
    return await loadGraphqlTools(source);
  }
  return [];
}

export async function compileExternalToolSource(source: ExternalToolSourceConfig): Promise<CompiledToolSourceArtifact> {
  const tools = await loadSourceToolDefinitions(source);
  return {
    version: "v1",
    sourceType: source.type,
    sourceName: source.name,
    tools: serializeTools(tools),
  };
}

export function compileOpenApiToolSourceFromPrepared(
  source: OpenApiToolSourceConfig,
  prepared: PreparedOpenApiSpec,
): CompiledToolSourceArtifact {
  const tools = buildOpenApiToolsFromPrepared(source, prepared);
  return {
    version: "v1",
    sourceType: source.type,
    sourceName: source.name,
    tools: serializeTools(tools),
  };
}

export function materializeCompiledToolSource(artifact: CompiledToolSourceArtifact): ToolDefinition[] {
  return rehydrateTools(artifact.tools, new Map());
}

export async function loadExternalTools(sources: ExternalToolSourceConfig[]): Promise<{ tools: ToolDefinition[]; warnings: string[] }> {
  const results = await Promise.allSettled(sources.map((source) => compileExternalToolSource(source)));

  const artifacts: CompiledToolSourceArtifact[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      artifacts.push(result.value);
    } else {
      const source = sources[i]!;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(`Failed to load ${source.type} source '${source.name}': ${message}`);
      console.warn(`[executor] failed to load tool source ${source.type}:${source.name}: ${message}`);
    }
  }

  const tools = artifacts.flatMap((artifact) => materializeCompiledToolSource(artifact));
  return { tools, warnings };
}

// ── Workspace tool cache serialization ──────────────────────────────────────
//
// Serializes ToolDefinition[] (minus `run` closures) into a JSON-safe format.
// On deserialization, `run` functions are reconstructed from stored metadata.

export interface WorkspaceToolSnapshot {
  version: "v2";
  externalArtifacts: CompiledToolSourceArtifact[];
  warnings: string[];
}

export function materializeWorkspaceSnapshot(
  snapshot: WorkspaceToolSnapshot,
): ToolDefinition[] {
  return snapshot.externalArtifacts.flatMap((artifact) => materializeCompiledToolSource(artifact));
}
