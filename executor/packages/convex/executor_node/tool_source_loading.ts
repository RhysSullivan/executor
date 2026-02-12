"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  compileExternalToolSource,
  compileOpenApiToolSourceFromPrepared,
  prepareOpenApiSpec,
  type CompiledToolSourceArtifact,
  type ExternalToolSourceConfig,
  type GraphqlToolSourceConfig,
  type McpToolSourceConfig,
  type OpenApiToolSourceConfig,
  type PreparedOpenApiSpec,
} from "../../core/src/tool-sources";
import type { ToolSourceRecord } from "../../core/src/types";

const OPENAPI_SPEC_CACHE_TTL_MS = 5 * 60 * 60_000;

/** Cache version - bump when PreparedOpenApiSpec shape changes. */
const OPENAPI_CACHE_VERSION = "v15";

export function sourceSignature(workspaceId: string, sources: Array<{ id: string; updatedAt: number; enabled: boolean }>): string {
  const signatureVersion = "v15";
  const parts = sources
    .map((source) => `${source.id}:${source.updatedAt}:${source.enabled ? 1 : 0}`)
    .sort();
  return `${signatureVersion}|${workspaceId}|${parts.join(",")}`;
}

export function normalizeExternalToolSource(raw: {
  id: string;
  type: ToolSourceRecord["type"];
  name: string;
  config: Record<string, unknown>;
}): ExternalToolSourceConfig {
  const config = raw.config;

  if (raw.type === "mcp") {
    if (typeof config.url !== "string" || config.url.trim().length === 0) {
      throw new Error(`MCP source '${raw.name}' missing url`);
    }

    if (
      config.transport !== undefined
      && config.transport !== "sse"
      && config.transport !== "streamable-http"
    ) {
      throw new Error(`MCP source '${raw.name}' has invalid transport`);
    }

    if (config.queryParams !== undefined) {
      const queryParams = config.queryParams;
      if (!queryParams || typeof queryParams !== "object" || Array.isArray(queryParams)) {
        throw new Error(`MCP source '${raw.name}' queryParams must be an object`);
      }

      for (const value of Object.values(queryParams as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new Error(`MCP source '${raw.name}' queryParams values must be strings`);
        }
      }
    }

    const result: McpToolSourceConfig = {
      type: "mcp",
      name: raw.name,
      sourceId: raw.id,
      sourceKey: `source:${raw.id}`,
      url: config.url,
      transport: config.transport as McpToolSourceConfig["transport"],
      queryParams: config.queryParams as McpToolSourceConfig["queryParams"],
      defaultApproval: config.defaultApproval as McpToolSourceConfig["defaultApproval"],
      overrides: config.overrides as McpToolSourceConfig["overrides"],
    };
    return result;
  }

  if (raw.type === "graphql") {
    if (typeof config.endpoint !== "string" || config.endpoint.trim().length === 0) {
      throw new Error(`GraphQL source '${raw.name}' missing endpoint`);
    }

    const result: GraphqlToolSourceConfig = {
      type: "graphql",
      name: raw.name,
      sourceId: raw.id,
      sourceKey: `source:${raw.id}`,
      endpoint: config.endpoint,
      schema: config.schema as GraphqlToolSourceConfig["schema"],
      auth: config.auth as GraphqlToolSourceConfig["auth"],
      defaultQueryApproval: config.defaultQueryApproval as GraphqlToolSourceConfig["defaultQueryApproval"],
      defaultMutationApproval: config.defaultMutationApproval as GraphqlToolSourceConfig["defaultMutationApproval"],
      overrides: config.overrides as GraphqlToolSourceConfig["overrides"],
    };
    return result;
  }

  const spec = config.spec;
  if (typeof spec !== "string" && (typeof spec !== "object" || spec === null)) {
    throw new Error(`OpenAPI source '${raw.name}' missing spec`);
  }

  const result: OpenApiToolSourceConfig = {
    type: "openapi",
    name: raw.name,
    sourceId: raw.id,
    sourceKey: `source:${raw.id}`,
    spec: spec as OpenApiToolSourceConfig["spec"],
    baseUrl: config.baseUrl as OpenApiToolSourceConfig["baseUrl"],
    auth: config.auth as OpenApiToolSourceConfig["auth"],
    defaultReadApproval: config.defaultReadApproval as OpenApiToolSourceConfig["defaultReadApproval"],
    defaultWriteApproval: config.defaultWriteApproval as OpenApiToolSourceConfig["defaultWriteApproval"],
    overrides: config.overrides as OpenApiToolSourceConfig["overrides"],
  };
  return result;
}

async function loadCachedOpenApiSpec(
  ctx: ActionCtx,
  specUrl: string,
  sourceName: string,
): Promise<PreparedOpenApiSpec> {
  try {
    const entry = await ctx.runQuery(internal.openApiSpecCache.getEntry, {
      specUrl,
      version: OPENAPI_CACHE_VERSION,
      maxAgeMs: OPENAPI_SPEC_CACHE_TTL_MS,
    });

    if (entry) {
      const blob = await ctx.storage.get(entry.storageId);
      if (blob) {
        const json = await blob.text();
        return JSON.parse(json) as PreparedOpenApiSpec;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] OpenAPI cache read failed for '${sourceName}': ${message}`);
  }

  const prepared = await prepareOpenApiSpec(specUrl, sourceName);

  try {
    const json = JSON.stringify(prepared);
    const blob = new Blob([json], { type: "application/json" });
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.openApiSpecCache.putEntry, {
      specUrl,
      version: OPENAPI_CACHE_VERSION,
      storageId,
      sizeBytes: json.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] OpenAPI cache write failed for '${sourceName}': ${message}`);
  }

  return prepared;
}

export async function loadSourceArtifact(
  ctx: ActionCtx,
  source: ExternalToolSourceConfig,
): Promise<{ artifact?: CompiledToolSourceArtifact; warnings: string[] }> {
  if (source.type === "openapi" && typeof source.spec === "string") {
    try {
      const prepared = await loadCachedOpenApiSpec(ctx, source.spec, source.name);
      const artifact = compileOpenApiToolSourceFromPrepared(source, prepared);
      const warnings = (prepared.warnings ?? []).map(
        (warning) => `Source '${source.name}': ${warning}`,
      );
      return { artifact, warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        artifact: undefined,
        warnings: [`Failed to load openapi source '${source.name}': ${message}`],
      };
    }
  }

  try {
    const artifact = await compileExternalToolSource(source);
    return { artifact, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      artifact: undefined,
      warnings: [`Failed to load ${source.type} source '${source.name}': ${message}`],
    };
  }
}
