import { Result } from "better-result";
import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { buildOpenApiToolsFromPrepared } from "../../../core/src/openapi/tool-builder";
import { resolveCredentialPayloadResult } from "../../../core/src/credential-providers";
import { serializeTools } from "../../../core/src/tool/source-serialization";
import {
  buildCredentialAuthHeaders,
  buildStaticAuthHeaders,
  readCredentialOverrideHeaders,
} from "../../../core/src/tool/source-auth";
import type {
  ExternalToolSourceConfig,
  GraphqlToolSourceConfig,
  McpToolSourceConfig,
  OpenApiAuth,
  OpenApiToolSourceConfig,
  PreparedOpenApiSpec,
} from "../../../core/src/tool/source-types";
import type { ToolSourceRecord } from "../../../core/src/types";
import { normalizeToolSourceConfig } from "../database/tool_source_config";
import { readWorkosVaultObjectViaAction } from "./workos_vault_reader";
import {
  parseCompiledToolSourceArtifact,
  type CompiledToolSourceArtifact,
} from "./tool_source_artifact";

const OPENAPI_SPEC_CACHE_TTL_MS = 5 * 60 * 60_000;

const OPENAPI_PREPARED_CACHE_VERSION = "openapi_v3";

const openApiAuthModeSchema = z.enum(["static", "account", "workspace", "organization"]);

const openApiAuthSchema = z.union([
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("basic"),
    mode: openApiAuthModeSchema.optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
  z.object({
    type: z.literal("bearer"),
    mode: openApiAuthModeSchema.optional(),
    token: z.string().optional(),
  }),
  z.object({
    type: z.literal("apiKey"),
    mode: openApiAuthModeSchema.optional(),
    header: z.string(),
    value: z.string().optional(),
  }),
]);

const preparedOpenApiSpecSchema = z.object({
  servers: z.array(z.string()),
  paths: z.record(z.unknown()),
  refHintTable: z.record(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  dts: z.string().optional(),
  dtsStatus: z.enum(["ready", "failed", "skipped"]).optional(),
  inferredAuth: openApiAuthSchema.optional(),
});

const rawToolSourceSchema = z.object({
  id: z.string(),
  type: z.enum(["mcp", "openapi", "graphql"]),
  name: z.string(),
  config: z.record(z.unknown()),
});

function toPreparedOpenApiSpec(value: unknown): PreparedOpenApiSpec | null {
  const parsed = preparedOpenApiSpecSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const valueRecord = parsed.data;

  return {
    servers: valueRecord.servers,
    paths: valueRecord.paths,
    refHintTable: valueRecord.refHintTable,
    warnings: valueRecord.warnings ?? [],
    dts: valueRecord.dts,
    dtsStatus: valueRecord.dtsStatus,
    inferredAuth: valueRecord.inferredAuth,
  };
}

function compileOpenApiArtifactFromPrepared(
  source: OpenApiToolSourceConfig,
  prepared: PreparedOpenApiSpec,
): CompiledToolSourceArtifact {
  const tools = buildOpenApiToolsFromPrepared(source, prepared);
  return {
    version: "v1",
    sourceType: source.type,
    sourceName: source.name,
    openApiSourceKey: source.sourceKey ?? `openapi:${source.name}`,
    ...(prepared.refHintTable && Object.keys(prepared.refHintTable).length > 0
      ? { openApiRefHintTable: prepared.refHintTable }
      : {}),
    tools: serializeTools(tools),
  };
}

export function normalizeExternalToolSource(raw: {
  id: string;
  type: ToolSourceRecord["type"];
  name: string;
  config: Record<string, unknown>;
}): Result<ExternalToolSourceConfig, Error> {
  const parsedRaw = rawToolSourceSchema.safeParse(raw);
  if (!parsedRaw.success) {
    return Result.err(new Error(`Failed to normalize tool source: ${parsedRaw.error.message}`));
  }
  const normalizedRaw = parsedRaw.data;

  if (normalizedRaw.type === "mcp") {
    const configResult = normalizeToolSourceConfig("mcp", normalizedRaw.config);
    if (configResult.isErr()) {
      return Result.err(
        new Error(`Failed to normalize '${normalizedRaw.name}' source config: ${configResult.error.message}`),
      );
    }
    const config = configResult.value;
    const result: McpToolSourceConfig = {
      type: "mcp",
      name: normalizedRaw.name,
      sourceId: normalizedRaw.id,
      sourceKey: `source:${normalizedRaw.id}`,
      url: config.url,
      auth: config.auth,
      transport: config.transport,
      queryParams: config.queryParams,
      defaultApproval: config.defaultApproval,
      overrides: config.overrides,
    };
    return Result.ok(result);
  }

  if (normalizedRaw.type === "graphql") {
    const configResult = normalizeToolSourceConfig("graphql", normalizedRaw.config);
    if (configResult.isErr()) {
      return Result.err(
        new Error(`Failed to normalize '${normalizedRaw.name}' source config: ${configResult.error.message}`),
      );
    }
    const config = configResult.value;
    const result: GraphqlToolSourceConfig = {
      type: "graphql",
      name: normalizedRaw.name,
      sourceId: normalizedRaw.id,
      sourceKey: `source:${normalizedRaw.id}`,
      endpoint: config.endpoint,
      schema: config.schema,
      auth: config.auth,
      defaultQueryApproval: config.defaultQueryApproval,
      defaultMutationApproval: config.defaultMutationApproval,
      overrides: config.overrides,
    };
    return Result.ok(result);
  }

  const configResult = normalizeToolSourceConfig("openapi", normalizedRaw.config);
  if (configResult.isErr()) {
    return Result.err(
      new Error(`Failed to normalize '${normalizedRaw.name}' source config: ${configResult.error.message}`),
    );
  }
  const config = configResult.value;

  const result: OpenApiToolSourceConfig = {
    type: "openapi",
    name: normalizedRaw.name,
    sourceId: normalizedRaw.id,
    sourceKey: `source:${normalizedRaw.id}`,
    spec: config.spec,
    collectionUrl: config.collectionUrl,
    postmanProxyUrl: config.postmanProxyUrl,
    baseUrl: config.baseUrl,
    auth: config.auth,
    defaultReadApproval: config.defaultReadApproval,
    defaultWriteApproval: config.defaultWriteApproval,
    overrides: config.overrides,
  };
  return Result.ok(result);
}

function toCredentialHeaderSpec(auth: OpenApiAuth):
  | { authType: "bearer" | "apiKey" | "basic"; headerName?: string }
  | null {
  if (auth.type === "none") {
    return null;
  }

  if (auth.type === "apiKey") {
    return {
      authType: "apiKey",
      headerName: auth.header,
    };
  }

  return {
    authType: auth.type,
  };
}

async function resolveMcpDiscoveryHeaders(
  ctx: ActionCtx,
  source: McpToolSourceConfig,
  workspaceId: Id<"workspaces">,
  accountId?: Id<"accounts">,
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
    scopeType: mode,
    accountId,
  });

  if (!record) {
    return {
      headers: {},
      warnings: [`Source '${source.name}': missing ${mode} credential for MCP discovery`],
    };
  }

  const readSecretResult = await resolveCredentialPayloadResult(record, {
    readVaultObject: async (input) => await readWorkosVaultObjectViaAction(ctx, input),
  });
  if (readSecretResult.isErr()) {
    return {
      headers: {},
      warnings: [`Source '${source.name}': failed to resolve MCP credential for discovery: ${readSecretResult.error.message}`],
    };
  }

  const secret = readSecretResult.value;
  if (!secret) {
    return {
      headers: {},
      warnings: [`Source '${source.name}': credential payload unavailable for MCP discovery`],
    };
  }

  const authSpec = toCredentialHeaderSpec(auth);
  if (!authSpec) {
    return { headers: {}, warnings: [] };
  }

  const headers = buildCredentialAuthHeaders(authSpec, secret);
  const overrideHeaders = readCredentialOverrideHeaders(record.overridesJson);
  for (const [key, value] of Object.entries(overrideHeaders)) {
    headers[key] = value;
  }

  if (Object.keys(headers).length === 0) {
    return {
      headers: {},
      warnings: [`Source '${source.name}': credential did not produce MCP auth headers for discovery`],
    };
  }

  return { headers, warnings: [] };
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
      version: OPENAPI_PREPARED_CACHE_VERSION,
      maxAgeMs: OPENAPI_SPEC_CACHE_TTL_MS,
    });

    if (entry) {
      const blob = await ctx.storage.get(entry.storageId);
      if (blob) {
        const json = await blob.text();
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(json);
        } catch {
          parsedJson = undefined;
        }

        if (parsedJson !== undefined) {
          const prepared = toPreparedOpenApiSpec(parsedJson);
          if (prepared && (!includeDts || getDtsStatus(prepared) !== "skipped")) {
            return prepared;
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] OpenAPI cache read failed for '${sourceName}': ${message}`);
  }

  const preparedResponse = await ctx.runAction(internal.runtimeNode.prepareOpenApiSpec, {
    specUrl,
    sourceName,
    includeDts,
  });
  const prepared = toPreparedOpenApiSpec(preparedResponse);
  if (!prepared) {
    throw new Error(`Prepared OpenAPI payload for '${sourceName}' was invalid`);
  }

  try {
    const json = JSON.stringify(prepared);
    const blob = new Blob([json], { type: "application/json" });
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.openApiSpecCache.putEntry, {
      specUrl,
      version: OPENAPI_PREPARED_CACHE_VERSION,
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
  options: { includeDts?: boolean; workspaceId: Id<"workspaces">; accountId?: Id<"accounts"> },
): Promise<{ artifact?: CompiledToolSourceArtifact; warnings: string[]; openApiDts?: string; openApiSourceKey?: string }> {
  const includeDts = options.includeDts ?? true;

  if (source.type === "openapi" && typeof source.spec === "string") {
    try {
      const prepared = await loadCachedOpenApiSpec(ctx, source.spec, source.name, includeDts);
      const artifact = compileOpenApiArtifactFromPrepared(source, prepared);
      const warnings = (prepared.warnings ?? []).map(
        (warning) => `Source '${source.name}': ${warning}`,
      );
      return {
        artifact,
        warnings,
        openApiDts: prepared.dts,
        openApiSourceKey: source.sourceKey ?? `openapi:${source.name}`,
      };
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
      options.accountId,
    );
    preWarnings.push(...resolved.warnings);
    sourceForCompile = {
      ...source,
      discoveryHeaders: resolved.headers,
    };
  }

  try {
    const artifactRaw = await ctx.runAction(internal.runtimeNode.compileExternalToolSource, {
      source: sourceForCompile as unknown as Record<string, unknown>,
    });
    const artifactResult = parseCompiledToolSourceArtifact(artifactRaw);
    if (artifactResult.isErr()) {
      throw artifactResult.error;
    }
    return { artifact: artifactResult.value, warnings: preWarnings };
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
