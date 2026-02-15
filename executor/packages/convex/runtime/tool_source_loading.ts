"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel.d.ts";
import {
  compileExternalToolSource,
  compileOpenApiToolSourceFromPrepared,
  prepareOpenApiSpec,
  type CompiledToolSourceArtifact,
} from "../../core/src/tool-sources";
import { resolveCredentialPayload } from "../../core/src/credential-providers";
import { buildStaticAuthHeaders } from "../../core/src/tool/source-auth";
import type {
  ExternalToolSourceConfig,
  GraphqlToolSourceConfig,
  McpToolSourceConfig,
  OpenApiAuth,
  OpenApiToolSourceConfig,
  PreparedOpenApiSpec,
} from "../../core/src/tool/source-types";
import type { ToolSourceRecord } from "../../core/src/types";
import { asPayload } from "../lib/object";

const OPENAPI_SPEC_CACHE_TTL_MS = 5 * 60 * 60_000;

/** Cache version - bump when tool snapshot/registry/type-hint semantics change. */
const TOOL_SOURCE_CACHE_VERSION = "v25";

export function sourceSignature(workspaceId: string, sources: Array<{ id: string; updatedAt: number; enabled: boolean }>): string {
  const parts = sources
    .map((source) => `${source.id}:${source.updatedAt}:${source.enabled ? 1 : 0}`)
    .sort();
  return `${TOOL_SOURCE_CACHE_VERSION}|${workspaceId}|${parts.join(",")}`;
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
      auth: config.auth as McpToolSourceConfig["auth"],
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

function buildHeadersFromCredentialSecret(
  auth: OpenApiAuth,
  secret: Record<string, unknown>,
): Record<string, string> {
  if (auth.type === "bearer") {
    const token = String(secret.token ?? "").trim();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  if (auth.type === "apiKey") {
    const value = String(secret.value ?? secret.token ?? "").trim();
    return value ? { [auth.header]: value } : {};
  }

  if (auth.type === "basic") {
    const username = String(secret.username ?? "");
    const password = String(secret.password ?? "");
    if (!username && !password) {
      return {};
    }
    const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    return { authorization: `Basic ${encoded}` };
  }

  return {};
}

async function resolveMcpDiscoveryHeaders(
  ctx: ActionCtx,
  source: McpToolSourceConfig,
  workspaceId: Id<"workspaces">,
  actorId?: string,
): Promise<{ headers: Record<string, string>; warnings: string[] }> {
  const auth = source.auth;
  if (!auth || auth.type === "none") {
    return { headers: {}, warnings: [] };
  }

  const mode = auth.mode ?? "static";
  if (mode === "static") {
    return { headers: buildStaticAuthHeaders(auth), warnings: [] };
  }

  if (!source.sourceKey) {
    return {
      headers: {},
      warnings: [`Source '${source.name}': missing source key for MCP credential discovery`],
    };
  }

  const record = await ctx.runQuery(internal.database.resolveCredential, {
    workspaceId,
    sourceKey: source.sourceKey,
    scope: mode,
    actorId,
  });

  if (!record) {
    return {
      headers: {},
      warnings: [`Source '${source.name}': missing ${mode} credential for MCP discovery`],
    };
  }

  try {
    const secret = await resolveCredentialPayload(record);
    if (!secret) {
      return {
        headers: {},
        warnings: [`Source '${source.name}': credential payload unavailable for MCP discovery`],
      };
    }

    const headers = buildHeadersFromCredentialSecret(auth, secret);
    const overrideHeaders = asPayload(asPayload(record.overridesJson).headers);
    for (const [key, value] of Object.entries(overrideHeaders)) {
      if (!key) continue;
      headers[key] = String(value);
    }

    if (Object.keys(headers).length === 0) {
      return {
        headers: {},
        warnings: [`Source '${source.name}': credential did not produce MCP auth headers for discovery`],
      };
    }

    return { headers, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      headers: {},
      warnings: [`Source '${source.name}': failed to resolve MCP credential for discovery: ${message}`],
    };
  }
}

async function loadCachedOpenApiSpec(
  ctx: ActionCtx,
  specUrl: string,
  sourceName: string,
  includeDts: boolean,
): Promise<PreparedOpenApiSpec> {
  const getDtsStatus = (prepared: PreparedOpenApiSpec): "ready" | "failed" | "skipped" => {
    if (prepared.dtsStatus) {
      return prepared.dtsStatus;
    }
    return prepared.dts ? "ready" : "failed";
  };

  try {
    const entry = await ctx.runQuery(internal.openApiSpecCache.getEntry, {
      specUrl,
      version: TOOL_SOURCE_CACHE_VERSION,
      maxAgeMs: OPENAPI_SPEC_CACHE_TTL_MS,
    });

    if (entry) {
      const blob = await ctx.storage.get(entry.storageId);
      if (blob) {
        const json = await blob.text();
        const prepared = JSON.parse(json) as PreparedOpenApiSpec;
        if (!includeDts || getDtsStatus(prepared) !== "skipped") {
          return prepared;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] OpenAPI cache read failed for '${sourceName}': ${message}`);
  }

  const prepared = await prepareOpenApiSpec(specUrl, sourceName, { includeDts });

  try {
    const json = JSON.stringify(prepared);
    const blob = new Blob([json], { type: "application/json" });
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.openApiSpecCache.putEntry, {
      specUrl,
      version: TOOL_SOURCE_CACHE_VERSION,
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
  options: { includeDts?: boolean; workspaceId: Id<"workspaces">; actorId?: string },
): Promise<{ artifact?: CompiledToolSourceArtifact; warnings: string[]; openApiDts?: string }> {
  const includeDts = options.includeDts ?? true;

  if (source.type === "openapi" && typeof source.spec === "string") {
    try {
      const prepared = await loadCachedOpenApiSpec(ctx, source.spec, source.name, includeDts);
      const artifact = compileOpenApiToolSourceFromPrepared(source, prepared);
      const warnings = (prepared.warnings ?? []).map(
        (warning) => `Source '${source.name}': ${warning}`,
      );
      return { artifact, warnings, openApiDts: prepared.dts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        artifact: undefined,
        warnings: [`Failed to load openapi source '${source.name}': ${message}`],
      };
    }
  }

  const preWarnings: string[] = [];
  let sourceForCompile: ExternalToolSourceConfig = source;

  if (source.type === "mcp") {
    const resolved = await resolveMcpDiscoveryHeaders(
      ctx,
      source,
      options.workspaceId,
      options.actorId,
    );
    preWarnings.push(...resolved.warnings);
    sourceForCompile = {
      ...source,
      discoveryHeaders: resolved.headers,
    };
  }

  try {
    const artifact = await compileExternalToolSource(sourceForCompile);
    return { artifact, warnings: preWarnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      artifact: undefined,
      warnings: [
        ...preWarnings,
        `Failed to load ${source.type} source '${source.name}': ${message}`,
      ],
    };
  }
}
