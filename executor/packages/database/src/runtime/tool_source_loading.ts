import { Result } from "better-result";
import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { resolveCredentialPayloadResult } from "../../../core/src/credential-providers";
import { buildOpenApiToolsFromPrepared } from "../../../core/src/openapi/tool-builder";
import { parseSerializedTool, serializeTools } from "../../../core/src/tool/source-serialization";
import {
  buildCredentialAuthHeaders,
  type CredentialHeaderAuthSpec,
  readCredentialAdditionalHeaders,
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
const OPENAPI_PREPARE_MAX_ATTEMPTS = 3;
const OPENAPI_PREPARE_RETRY_BASE_DELAY_MS = 1_500;

const OPENAPI_PREPARED_CACHE_VERSION = "openapi_v11";
const OPENAPI_ARTIFACT_CACHE_VERSION = "openapi_artifact_v1";
const OPENAPI_ARTIFACT_CACHE_TTL_MS = 24 * 60 * 60_000;

const openApiAuthModeSchema = z.enum(["account", "workspace", "organization"]);

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

const preparedOpenApiEnvelopeSchema = z.object({
  storageId: z.string(),
  sizeBytes: z.number().optional(),
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function sharedOpenApiArtifactCacheKey(source: OpenApiToolSourceConfig): string {
  return `openapi-artifact:${stableStringify({
    name: source.name,
    spec: source.spec,
    baseUrl: source.baseUrl,
    auth: source.auth,
    defaultReadApproval: source.defaultReadApproval,
    defaultWriteApproval: source.defaultWriteApproval,
    overrides: source.overrides,
  })}`;
}

function canUseSharedOpenApiArtifactCache(source: OpenApiToolSourceConfig): boolean {
  return typeof source.spec === "string";
}

function rebindOpenApiArtifactToSource(
  artifact: CompiledToolSourceArtifact,
  source: OpenApiToolSourceConfig,
): CompiledToolSourceArtifact {
  const sourceKey = source.sourceKey ?? `source:${source.name}`;

  const reboundTools = artifact.tools.map((rawTool) => {
    const parsed = parseSerializedTool(rawTool);
    if (parsed.isErr()) {
      return rawTool;
    }

    const tool = parsed.value;
    return {
      ...tool,
      ...(tool.typing?.typedRef?.kind === "openapi_operation"
        ? {
          typing: {
            ...tool.typing,
            typedRef: {
              ...tool.typing.typedRef,
              sourceKey,
            },
          },
        }
        : {}),
      ...(tool.credential
        ? {
          credential: {
            ...tool.credential,
            sourceKey,
          },
        }
        : {}),
    };
  });

  return {
    ...artifact,
    sourceName: source.name,
    openApiSourceKey: sourceKey,
    tools: reboundTools,
  };
}

async function loadSharedOpenApiArtifactCache(
  ctx: ActionCtx,
  key: string,
): Promise<CompiledToolSourceArtifact | null> {
  try {
    const entry = await ctx.runQuery(internal.openApiSpecCache.getEntry, {
      specUrl: key,
      version: OPENAPI_ARTIFACT_CACHE_VERSION,
      maxAgeMs: OPENAPI_ARTIFACT_CACHE_TTL_MS,
    });

    if (!entry) {
      return null;
    }

    const blob = await ctx.storage.get(entry.storageId);
    if (!blob) {
      return null;
    }

    const payload = JSON.parse(await blob.text());
    const parsed = parseCompiledToolSourceArtifact(payload);
    if (parsed.isErr()) {
      return null;
    }

    return parsed.value;
  } catch {
    return null;
  }
}

async function putSharedOpenApiArtifactCache(
  ctx: ActionCtx,
  key: string,
  artifact: CompiledToolSourceArtifact,
): Promise<void> {
  try {
    const json = JSON.stringify(artifact);
    const storageId = await ctx.storage.store(new Blob([json], { type: "application/json" }));
    await ctx.runMutation(internal.openApiSpecCache.putEntry, {
      specUrl: key,
      version: OPENAPI_ARTIFACT_CACHE_VERSION,
      storageId,
      sizeBytes: json.length,
    });
  } catch {
    // Best-effort cache write.
  }
}

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

function toCredentialHeaderSpec(auth: OpenApiAuth): CredentialHeaderAuthSpec | null {
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

  const mode = auth.mode ?? "workspace";

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
  const additionalHeaders = readCredentialAdditionalHeaders(record.additionalHeaders);
  for (const [key, value] of Object.entries(additionalHeaders)) {
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

  let preparedResponse: unknown = undefined;
  let lastPrepareError: string | undefined;
  for (let attempt = 1; attempt <= OPENAPI_PREPARE_MAX_ATTEMPTS; attempt += 1) {
    try {
      preparedResponse = await ctx.runAction(internal.runtimeNode.prepareOpenApiSpec, {
        specUrl,
        sourceName,
        includeDts,
      });
      lastPrepareError = undefined;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastPrepareError = message;
      if (attempt >= OPENAPI_PREPARE_MAX_ATTEMPTS) {
        break;
      }

      const delayMs = OPENAPI_PREPARE_RETRY_BASE_DELAY_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (lastPrepareError) {
    throw new Error(
      `Failed to prepare OpenAPI source '${sourceName}' after ${OPENAPI_PREPARE_MAX_ATTEMPTS} attempts: ${lastPrepareError}`,
    );
  }

  let preparedPayload: unknown;
  let preparedStorageId: Id<"_storage"> | undefined;
  let preparedSizeBytes: number | undefined;
  if (typeof preparedResponse === "string") {
    try {
      const parsed = JSON.parse(preparedResponse) as unknown;
      const parsedEnvelope = preparedOpenApiEnvelopeSchema.safeParse(parsed);
      if (parsedEnvelope.success) {
        preparedStorageId = parsedEnvelope.data.storageId as Id<"_storage">;
        preparedSizeBytes = parsedEnvelope.data.sizeBytes;

        const blob = await ctx.storage.get(preparedStorageId);
        if (!blob) {
          throw new Error(`Prepared OpenAPI blob missing for '${sourceName}'`);
        }
        const text = await blob.text();
        preparedPayload = JSON.parse(text);
      } else {
        preparedPayload = parsed;
      }
    } catch {
      preparedPayload = undefined;
    }
  } else {
    preparedPayload = preparedResponse;
  }

  const prepared = toPreparedOpenApiSpec(preparedPayload);
  if (!prepared) {
    throw new Error(`Prepared OpenAPI payload for '${sourceName}' was invalid`);
  }

  try {
    const json = JSON.stringify(prepared);
    const storageId = preparedStorageId ?? await ctx.storage.store(new Blob([json], { type: "application/json" }));
    await ctx.runMutation(internal.openApiSpecCache.putEntry, {
      specUrl,
      version: OPENAPI_PREPARED_CACHE_VERSION,
      storageId,
      sizeBytes: preparedSizeBytes ?? json.length,
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
      const sharedArtifactCacheEligible = canUseSharedOpenApiArtifactCache(source);
      const sharedArtifactCacheKey = sharedArtifactCacheEligible
        ? sharedOpenApiArtifactCacheKey(source)
        : undefined;

      if (sharedArtifactCacheEligible && sharedArtifactCacheKey) {
        const cachedArtifact = await loadSharedOpenApiArtifactCache(ctx, sharedArtifactCacheKey);
        if (cachedArtifact) {
          return {
            artifact: rebindOpenApiArtifactToSource(cachedArtifact, source),
            warnings: [],
            openApiSourceKey: source.sourceKey ?? `openapi:${source.name}`,
          };
        }
      }

      const prepared = await loadCachedOpenApiSpec(ctx, source.spec, source.name, includeDts);
      const artifact = compileOpenApiArtifactFromPrepared(source, prepared);

      if (sharedArtifactCacheEligible && sharedArtifactCacheKey) {
        await putSharedOpenApiArtifactCache(ctx, sharedArtifactCacheKey, artifact);
      }

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
