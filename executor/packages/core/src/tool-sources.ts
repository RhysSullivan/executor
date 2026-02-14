"use node";

import { loadGraphqlTools } from "./tool-source-loaders/graphql-loader";
import { loadMcpTools } from "./tool-source-loaders/mcp-loader";
import { loadOpenApiTools } from "./tool-source-loaders/openapi-loader";
import { buildOpenApiToolsFromPrepared } from "./openapi-tool-builder";
import { rehydrateTools, serializeTools, type SerializedTool } from "./tool-source-serialization";
import type {
  ExternalToolSourceConfig,
  OpenApiToolSourceConfig,
  PreparedOpenApiSpec,
} from "./tool-source-types";
import type { ToolDefinition } from "./types";

export type {
  ExternalToolSourceConfig,
  GraphqlToolSourceConfig,
  McpToolSourceConfig,
  OpenApiAuth,
  OpenApiToolSourceConfig,
  PreparedOpenApiSpec,
} from "./tool-source-types";
export { prepareOpenApiSpec } from "./openapi-prepare";
export { parseGraphqlOperationPaths } from "./graphql-operation-paths";
export { rehydrateTools, serializeTools, type SerializedTool } from "./tool-source-serialization";
export { buildOpenApiToolsFromPrepared } from "./openapi-tool-builder";

export interface CompiledToolSourceArtifact {
  version: "v1";
  sourceType: ExternalToolSourceConfig["type"];
  sourceName: string;
  tools: SerializedTool[];
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
