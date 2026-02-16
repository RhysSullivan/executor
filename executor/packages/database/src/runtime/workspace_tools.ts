"use node";

import { Result } from "better-result";
import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { buildWorkspaceTypeBundle } from "../../../core/src/tool-typing/typebundle";
import { jsonSchemaTypeHintFallback } from "../../../core/src/openapi/schema-hints";
import { buildPreviewKeys, extractTopLevelRequiredKeys } from "../../../core/src/tool-typing/schema-utils";
import {
  materializeCompiledToolSource,
  parseWorkspaceToolSnapshot,
  materializeWorkspaceSnapshot,
  type CompiledToolSourceArtifact,
  type WorkspaceToolSnapshot,
} from "../../../core/src/tool-sources";
import type { SerializedTool } from "../../../core/src/tool/source-serialization";
import type { ExternalToolSourceConfig } from "../../../core/src/tool/source-types";
import type {
  AccessPolicyRecord,
  JsonSchema,
  OpenApiSourceQuality,
  SourceAuthProfile,
  ToolDefinition,
  ToolDescriptor,
  ToolSourceRecord,
} from "../../../core/src/types";
import { computeOpenApiSourceQuality, listVisibleToolDescriptors } from "./tool_descriptors";
import { loadSourceArtifact, normalizeExternalToolSource, sourceSignature } from "./tool_source_loading";
import { registrySignatureForWorkspace } from "./tool_registry_state";
import { normalizeToolPathForLookup } from "./tool_paths";

const baseTools = new Map<string, ToolDefinition>();

const adminAnnouncementInputSchema = z.object({
  channel: z.string().optional(),
  message: z.string().optional(),
});

const accountScopedMcpAuthSchema = z.object({
  mode: z.literal("account"),
});

const toolHintSchema = z.object({
  inputHint: z.string().optional(),
  outputHint: z.string().optional(),
  requiredInputKeys: z.array(z.string()).optional(),
  previewInputKeys: z.array(z.string()).optional(),
});

const payloadRecordSchema = z.record(z.unknown());

function toInputPayload(value: unknown): Record<string, unknown> {
  const parsed = payloadRecordSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return value === undefined ? {} : { value };
}

function toJsonSchema(value: unknown): JsonSchema {
  const parsed = payloadRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

async function listWorkspaceToolSources(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<ToolSourceRecord[]> {
  const sources: ToolSourceRecord[] = await ctx.runQuery(internal.database.listToolSources, { workspaceId });
  return sources;
}

async function listWorkspaceAccessPolicies(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  accountId?: Id<"accounts">,
): Promise<AccessPolicyRecord[]> {
  const policies: AccessPolicyRecord[] = await ctx.runQuery(internal.database.listAccessPolicies, { workspaceId, accountId });
  return policies;
}

async function parseWorkspaceToolSnapshotFromBlob(blob: Blob): Promise<Result<WorkspaceToolSnapshot, Error>> {
  let text: string;
  try {
    text = await blob.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Result.err(new Error(`Failed to read cache blob: ${message}`));
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Result.err(new Error(`Failed to parse cache JSON: ${message}`));
  }

  return parseWorkspaceToolSnapshot(parsedJson);
}

// Minimal built-in tools used by tests/demos.
// These are intentionally simple and are always approval-gated.
baseTools.set("admin.send_announcement", {
  path: "admin.send_announcement",
  source: "system",
  approval: "required",
  description: "Send an announcement message (demo tool; approval-gated).",
  typing: {
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        message: { type: "string" },
      },
      required: ["channel", "message"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        channel: { type: "string" },
        message: { type: "string" },
      },
      required: ["ok", "channel", "message"],
      additionalProperties: false,
    },
  },
  run: async (input: unknown) => {
    const parsedInput = adminAnnouncementInputSchema.safeParse(toInputPayload(input));
    const channel = parsedInput.success ? (parsedInput.data.channel ?? "") : "";
    const message = parsedInput.success ? (parsedInput.data.message ?? "") : "";
    return { ok: true, channel, message };
  },
});

baseTools.set("admin.delete_data", {
  path: "admin.delete_data",
  source: "system",
  approval: "required",
  description: "Delete data (demo tool; approval-gated).",
  typing: {
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        id: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
      additionalProperties: false,
    },
  },
  run: async () => {
    return { ok: true };
  },
});

// System tools (discover/catalog) are resolved server-side.
// Their execution is handled in the Convex tool invocation pipeline.
baseTools.set("discover", {
  path: "discover",
  source: "system",
  approval: "auto",
  description:
    "Search available tools by keyword. Returns preferred path aliases, signature hints, and ready-to-copy call examples. Compact mode is enabled by default.",
  typing: {
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        depth: { type: "number" },
        limit: { type: "number" },
        compact: { type: "boolean" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        bestPath: {},
        results: { type: "array" },
        total: { type: "number" },
      },
      required: ["bestPath", "results", "total"],
    },
  },
  run: async () => {
    throw new Error("discover is handled by the server tool invocation pipeline");
  },
});

baseTools.set("catalog.namespaces", {
  path: "catalog.namespaces",
  source: "system",
  approval: "auto",
  description: "List available tool namespaces with counts and sample callable paths.",
  typing: {
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        namespaces: { type: "array" },
        total: { type: "number" },
      },
      required: ["namespaces", "total"],
    },
  },
  run: async () => {
    throw new Error("catalog.namespaces is handled by the server tool invocation pipeline");
  },
});

baseTools.set("catalog.tools", {
  path: "catalog.tools",
  source: "system",
  approval: "auto",
  description: "List tools with typed signatures. Supports namespace and query filters in one call.",
  typing: {
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string" },
        depth: { type: "number" },
        limit: { type: "number" },
        compact: { type: "boolean" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        results: { type: "array" },
        total: { type: "number" },
      },
      required: ["results", "total"],
    },
  },
  run: async () => {
    throw new Error("catalog.tools is handled by the server tool invocation pipeline");
  },
});

interface WorkspaceToolsResult {
  tools: Map<string, ToolDefinition>;
  warnings: string[];
  typesStorageId?: Id<"_storage">;
  debug: WorkspaceToolsDebug;
}

export interface WorkspaceToolsDebug {
  mode: "cache-fresh" | "cache-stale" | "rebuild";
  includeDts: boolean;
  sourceTimeoutMs: number | null;
  skipCacheRead: boolean;
  sourceCount: number;
  normalizedSourceCount: number;
  cacheHit: boolean;
  cacheFresh: boolean | null;
  timedOutSources: string[];
  durationMs: number;
  trace: string[];
}

interface GetWorkspaceToolsOptions {
  sourceTimeoutMs?: number;
  allowStaleOnMismatch?: boolean;
  skipCacheRead?: boolean;
  accountId?: Id<"accounts">;
}

interface WorkspaceToolInventory {
  tools: ToolDescriptor[];
  warnings: string[];
  typesUrl?: string;
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  debug: WorkspaceToolsDebug;
}

const MAX_TOOLS_IN_ACTION_RESULT = 8_000;

function truncateToolsForActionResult(
  tools: ToolDescriptor[],
  warnings: string[],
): { tools: ToolDescriptor[]; warnings: string[] } {
  if (tools.length <= MAX_TOOLS_IN_ACTION_RESULT) {
    return { tools, warnings };
  }

  return {
    tools: tools.slice(0, MAX_TOOLS_IN_ACTION_RESULT),
    warnings: [
      ...warnings,
      `Tool inventory truncated to ${MAX_TOOLS_IN_ACTION_RESULT} of ${tools.length} tools (Convex array limit). Use source filters or targeted lookups to narrow results.`,
    ],
  };
}

function computeSourceAuthProfiles(tools: Map<string, ToolDefinition>): Record<string, SourceAuthProfile> {
  const profiles: Record<string, SourceAuthProfile> = {};

  for (const tool of tools.values()) {
    const credential = tool.credential;
    if (!credential) continue;

    const sourceKey = credential.sourceKey;
    const current = profiles[sourceKey];
    if (!current) {
      profiles[sourceKey] = {
        type: credential.authType,
        mode: credential.mode,
        ...(credential.authType === "apiKey" && credential.headerName
          ? { header: credential.headerName }
          : {}),
        inferred: true,
      };
      continue;
    }

    if (current.type !== credential.authType || current.mode !== credential.mode) {
      profiles[sourceKey] = {
        type: "mixed",
        inferred: true,
      };
    }
  }

  return profiles;
}

function mergeTools(externalTools: Iterable<ToolDefinition>): Map<string, ToolDefinition> {
  const merged = new Map<string, ToolDefinition>();

  for (const tool of baseTools.values()) {
    merged.set(tool.path, tool);
  }

  for (const tool of externalTools) {
    merged.set(tool.path, tool);
  }
  return merged;
}

function tokenizePathSegment(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

const GENERIC_NAMESPACE_SUFFIXES = new Set([
  "api",
  "apis",
  "openapi",
  "sdk",
  "service",
  "services",
]);

function simplifyNamespaceSegment(segment: string): string {
  const tokens = tokenizePathSegment(segment);
  if (tokens.length === 0) return segment;

  const collapsed: string[] = [];
  for (const token of tokens) {
    if (collapsed[collapsed.length - 1] === token) continue;
    collapsed.push(token);
  }

  while (collapsed.length > 1) {
    const last = collapsed[collapsed.length - 1];
    if (!last || !GENERIC_NAMESPACE_SUFFIXES.has(last)) break;
    collapsed.pop();
  }

  return collapsed.join("_");
}

function preferredToolPath(path: string): string {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return path;

  const simplifiedNamespace = simplifyNamespaceSegment(segments[0]!);
  if (!simplifiedNamespace || simplifiedNamespace === segments[0]) {
    return path;
  }

  return [simplifiedNamespace, ...segments.slice(1)].join(".");
}

function toCamelSegment(segment: string): string {
  return segment.replace(/_+([a-z0-9])/g, (_m, char: string) => char.toUpperCase());
}

function getPathAliases(path: string): string[] {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return [];

  const canonicalPath = path;
  const publicPath = preferredToolPath(path);

  const aliases = new Set<string>();
  const publicSegments = publicPath.split(".").filter(Boolean);
  const camelPath = publicSegments.map(toCamelSegment).join(".");
  const compactPath = publicSegments.map((segment) => segment.replace(/[_-]/g, "")).join(".");
  const lowerPath = publicPath.toLowerCase();

  if (publicPath !== canonicalPath) aliases.add(publicPath);
  if (camelPath !== publicPath) aliases.add(camelPath);
  if (compactPath !== publicPath) aliases.add(compactPath);
  if (lowerPath !== publicPath) aliases.add(lowerPath);

  return [...aliases].slice(0, 4);
}


function normalizeHint(type?: string): string {
  return type && type.trim().length > 0 ? type : "unknown";
}

async function buildWorkspaceToolRegistry(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    registrySignature: string;
    serializedTools: SerializedTool[];
  },
): Promise<{ buildId: string }> {
  const buildId = `toolreg_${crypto.randomUUID()}`;
  await ctx.runMutation(internal.toolRegistry.beginBuild, {
    workspaceId: args.workspaceId,
    signature: args.registrySignature,
    buildId,
  });

  const entries = args.serializedTools.map((st) => {
    if (st.path === "discover" || st.path.startsWith("catalog.")) {
      return null;
    }
    const preferredPath = preferredToolPath(st.path);
    const aliases = getPathAliases(st.path);
    const namespace = (preferredPath.split(".")[0] ?? "default").toLowerCase();
    const normalizedPath = normalizeToolPathForLookup(st.path);
    const searchText = `${st.path} ${preferredPath} ${aliases.join(" ")} ${st.description} ${st.source ?? ""}`.toLowerCase();

    const inputSchema = toJsonSchema(st.typing?.inputSchema);
    const outputSchema = toJsonSchema(st.typing?.outputSchema);
    const parsedTyping = toolHintSchema.safeParse(st.typing);
    const typing = parsedTyping.success ? parsedTyping.data : {};

    const requiredInputKeys = typing.requiredInputKeys ?? extractTopLevelRequiredKeys(inputSchema);
    const previewInputKeys = typing.previewInputKeys ?? buildPreviewKeys(inputSchema);
    const inputHint = typing.inputHint?.trim();
    const outputHint = typing.outputHint?.trim();

    const displayInput = inputHint && inputHint.length > 0
      ? inputHint
      : (Object.keys(inputSchema).length === 0
        ? "{}"
        : normalizeHint(jsonSchemaTypeHintFallback(inputSchema)));

    const displayOutput = outputHint && outputHint.length > 0
      ? outputHint
      : (Object.keys(outputSchema).length === 0
        ? "unknown"
        : normalizeHint(jsonSchemaTypeHintFallback(outputSchema)));

    const typedRef = st.typing?.typedRef && st.typing.typedRef.kind === "openapi_operation"
      ? {
          kind: "openapi_operation" as const,
          sourceKey: st.typing.typedRef.sourceKey,
          operationId: st.typing.typedRef.operationId,
        }
      : undefined;

    return {
      path: st.path,
      preferredPath,
      namespace,
      normalizedPath,
      aliases,
      description: st.description,
      approval: st.approval,
      source: st.source,
      searchText,
      displayInput,
      displayOutput,
      requiredInputKeys,
      previewInputKeys,
      typedRef,
      serializedToolJson: JSON.stringify(st),
    };
  });

  const filteredEntries = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const namespaceMap = new Map<string, { toolCount: number; samplePaths: string[] }>();
  for (const entry of filteredEntries) {
    const current = namespaceMap.get(entry.namespace) ?? { toolCount: 0, samplePaths: [] };
    current.toolCount += 1;
    if (current.samplePaths.length < 6) {
      current.samplePaths.push(entry.preferredPath);
    }
    namespaceMap.set(entry.namespace, current);
  }

  const namespaces = [...namespaceMap.entries()]
    .map(([namespace, meta]) => ({
      namespace,
      toolCount: meta.toolCount,
      samplePaths: [...meta.samplePaths].sort((a, b) => a.localeCompare(b)).slice(0, 3),
    }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));

  const TOOL_BATCH = 100;
  for (let i = 0; i < filteredEntries.length; i += TOOL_BATCH) {
    await ctx.runMutation(internal.toolRegistry.putToolsBatch, {
      workspaceId: args.workspaceId,
      buildId,
      tools: filteredEntries.slice(i, i + TOOL_BATCH),
    });
  }

  const NS_BATCH = 100;
  for (let i = 0; i < namespaces.length; i += NS_BATCH) {
    await ctx.runMutation(internal.toolRegistry.putNamespacesBatch, {
      workspaceId: args.workspaceId,
      buildId,
      namespaces: namespaces.slice(i, i + NS_BATCH),
    });
  }

  await ctx.runMutation(internal.toolRegistry.finishBuild, {
    workspaceId: args.workspaceId,
    buildId,
  });

  await ctx.runAction(internal.toolRegistry.pruneBuilds, {
    workspaceId: args.workspaceId,
    maxRetainedBuilds: 2,
  });

  return { buildId };
}

// No implicit "ensure"/backfill on reads: the registry is built alongside the
// workspace tool snapshot during rebuilds.

export async function getWorkspaceTools(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: GetWorkspaceToolsOptions = {},
): Promise<WorkspaceToolsResult> {
  const startedAt = Date.now();
  const trace: string[] = [];
  const traceStep = (label: string, stepStartedAt: number) => {
    trace.push(`${label}=${Date.now() - stepStartedAt}ms`);
  };

  const listSourcesStartedAt = Date.now();
  const includeDts = true;
  const sourceTimeoutMs = options.sourceTimeoutMs;
  const allowStaleOnMismatch = options.allowStaleOnMismatch ?? false;
  const accountId = options.accountId;
  const sources = (await listWorkspaceToolSources(ctx, workspaceId))
    .filter((source) => source.enabled);
  const hasAccountScopedMcpSource = sources.some((source) => {
    if (source.type !== "mcp") {
      return false;
    }

    const auth = accountScopedMcpAuthSchema.safeParse(source.config.auth);
    return auth.success;
  });
  const skipCacheRead = (options.skipCacheRead ?? false) || hasAccountScopedMcpSource;
  const skipCacheWrite = hasAccountScopedMcpSource;
  traceStep("listToolSources", listSourcesStartedAt);
  const hasOpenApiSource = sources.some((source) => source.type === "openapi");
  const signature = sourceSignature(workspaceId, sources);
  const registrySignature = registrySignatureForWorkspace(workspaceId, sources);
  const debugBase: Omit<WorkspaceToolsDebug, "mode" | "normalizedSourceCount" | "cacheHit" | "cacheFresh" | "timedOutSources" | "durationMs" | "trace"> = {
      includeDts,
      sourceTimeoutMs: sourceTimeoutMs ?? null,
      skipCacheRead,
    sourceCount: sources.length,
  };

  if (!skipCacheRead) {
    try {
    const cacheReadStartedAt = Date.now();
    const cacheEntry = await ctx.runQuery(internal.workspaceToolCache.getEntry, {
      workspaceId,
      signature,
    });
    traceStep("cacheEntryLookup", cacheReadStartedAt);

    if (cacheEntry) {
      const cacheHydrateStartedAt = Date.now();
      const blob = await ctx.storage.get(cacheEntry.storageId);
      if (blob) {
        const parsedSnapshot = await parseWorkspaceToolSnapshotFromBlob(blob);
        if (parsedSnapshot.isErr()) {
          trace.push("cacheHydrate=invalidSnapshot");
          console.warn(`[executor] invalid workspace tool cache snapshot for '${workspaceId}': ${parsedSnapshot.error.message}`);
        } else {
          const snapshot = parsedSnapshot.value;
          const restored = materializeWorkspaceSnapshot(snapshot);
          const merged = mergeTools(restored);
          traceStep("cacheHydrate", cacheHydrateStartedAt);

          const typesStorageId: Id<"_storage"> | undefined = cacheEntry.typesStorageId;
          if (cacheEntry.isFresh) {
            if (typesStorageId) {
              return {
                tools: merged,
                warnings: snapshot.warnings,
                typesStorageId,
                debug: {
                  ...debugBase,
                  mode: "cache-fresh",
                  normalizedSourceCount: sources.length,
                  cacheHit: true,
                  cacheFresh: true,
                  timedOutSources: [],
                  durationMs: Date.now() - startedAt,
                  trace,
                },
              };
            }
            // Continue into rebuild path to generate missing type bundle.
          } else if (allowStaleOnMismatch) {
            return {
              tools: merged,
              warnings: [...snapshot.warnings, "Tool sources changed; showing previous results while refreshing."],
              typesStorageId,
              debug: {
                ...debugBase,
                mode: "cache-stale",
                normalizedSourceCount: sources.length,
                cacheHit: true,
                cacheFresh: false,
                timedOutSources: [],
                durationMs: Date.now() - startedAt,
                trace,
              },
            };
          }
        }
      }
    }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[executor] workspace tool cache read failed for '${workspaceId}': ${msg}`);
    }
  } else {
    trace.push("cacheEntryLookup=skipped");
  }

  const configs: ExternalToolSourceConfig[] = [];
  const warnings: string[] = [];
  const normalizeSourcesStartedAt = Date.now();
  for (const source of sources) {
    const normalizedResult = normalizeExternalToolSource(source);
    if (normalizedResult.isErr()) {
      warnings.push(`Source '${source.name}': ${normalizedResult.error.message}`);
      continue;
    }
    configs.push(normalizedResult.value);
  }
  traceStep("normalizeSources", normalizeSourcesStartedAt);

  const loadSourcesStartedAt = Date.now();
  const loadedSources = await Promise.all(configs.map(async (config) => {
    if (!sourceTimeoutMs || sourceTimeoutMs <= 0) {
      return {
        ...(await loadSourceArtifact(ctx, config, { includeDts, workspaceId, accountId })),
        timedOut: false,
        sourceName: config.name,
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<{
      artifact?: CompiledToolSourceArtifact;
      warnings: string[];
      timedOut: boolean;
      sourceName: string;
      openApiDts?: string;
      openApiSourceKey?: string;
    }>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          artifact: undefined,
          warnings: [`Source '${config.name}' is still loading; showing partial results.`],
          timedOut: true,
          sourceName: config.name,
          openApiDts: undefined,
          openApiSourceKey: config.type === "openapi" ? (config.sourceKey ?? `openapi:${config.name}`) : undefined,
        });
      }, sourceTimeoutMs);
    });

    const loadResult = loadSourceArtifact(ctx, config, { includeDts, workspaceId, accountId })
      .then((result) => ({ ...result, timedOut: false, sourceName: config.name }));

    const result = await Promise.race([loadResult, timeoutResult]);
    if (timer && !result.timedOut) {
      clearTimeout(timer);
    }
    return result;
  }));
  traceStep("loadSources", loadSourcesStartedAt);
  const externalArtifacts = loadedSources
    .map((loaded) => loaded.artifact)
    .filter((artifact): artifact is CompiledToolSourceArtifact => Boolean(artifact));
  const externalTools = externalArtifacts.flatMap((artifact) => materializeCompiledToolSource(artifact));
  warnings.push(...loadedSources.flatMap((loaded) => loaded.warnings));
  const hasTimedOutSource = loadedSources.some((loaded) => loaded.timedOut);
  const timedOutSources = loadedSources
    .filter((loaded) => loaded.timedOut)
    .map((loaded) => loaded.sourceName);
  const merged = mergeTools(externalTools);

  let typesStorageId: Id<"_storage"> | undefined;
  try {
    if (hasTimedOutSource) {
      return {
        tools: merged,
        warnings,
        typesStorageId,
        debug: {
          ...debugBase,
          mode: "rebuild",
          normalizedSourceCount: configs.length,
          cacheHit: false,
          cacheFresh: null,
          timedOutSources,
          durationMs: Date.now() - startedAt,
          trace,
        },
      };
    }

    const snapshotWriteStartedAt = Date.now();
    const allTools = [...merged.values()];

    // Build a per-tool registry for fast discover + invocation.
    const registryStartedAt = Date.now();
    await buildWorkspaceToolRegistry(ctx, {
      workspaceId,
      registrySignature,
      serializedTools: externalArtifacts.flatMap((artifact) => artifact.tools),
    });
    traceStep("toolRegistryWrite", registryStartedAt);

    // Build and store a workspace-wide Monaco type bundle.
    const openApiDtsBySource: Record<string, string> = {};
    for (const loaded of loadedSources) {
      if (loaded.openApiDts && loaded.openApiDts.trim().length > 0) {
        const sourceKey = loaded.openApiSourceKey ?? `openapi:${loaded.sourceName}`;
        openApiDtsBySource[sourceKey] = loaded.openApiDts;
      }
    }
    const typeBundle = buildWorkspaceTypeBundle({
      tools: allTools,
      openApiDtsBySource,
    });
    const typesBlob = new Blob([typeBundle], { type: "text/plain" });
    typesStorageId = await ctx.storage.store(typesBlob);

    const snapshot: WorkspaceToolSnapshot = {
      version: "v2",
      externalArtifacts,
      warnings,
    };

    if (!skipCacheWrite) {
      const json = JSON.stringify(snapshot);
      const blob = new Blob([json], { type: "application/json" });
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.workspaceToolCache.putEntry, {
        workspaceId,
        signature,
        storageId,
        typesStorageId,
        toolCount: allTools.length,
        sizeBytes: json.length,
      });
      traceStep("snapshotWrite", snapshotWriteStartedAt);
    } else {
      trace.push("snapshotWrite=skipped(account-scoped-mcp)");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] workspace tool cache write failed for '${workspaceId}': ${msg}`);
  }

  return {
    tools: merged,
    warnings,
    typesStorageId,
    debug: {
      ...debugBase,
      mode: "rebuild",
      normalizedSourceCount: configs.length,
      cacheHit: false,
      cacheFresh: null,
      timedOutSources,
      durationMs: Date.now() - startedAt,
      trace,
    },
  };
}

async function loadWorkspaceToolInventoryForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
  options: {
    includeDetails?: boolean;
    includeSourceMeta?: boolean;
    toolPaths?: string[];
    sourceTimeoutMs?: number;
    allowStaleOnMismatch?: boolean;
    skipCacheRead?: boolean;
  } = {},
): Promise<WorkspaceToolInventory> {
  const includeDetails = options.includeDetails ?? true;
  const includeSourceMeta = options.includeSourceMeta ?? true;
  const sourceTimeoutMs = options.sourceTimeoutMs;
  const allowStaleOnMismatch = options.allowStaleOnMismatch;
  const skipCacheRead = options.skipCacheRead;
  const [result, policies] = await Promise.all([
    getWorkspaceTools(ctx, context.workspaceId, {
      sourceTimeoutMs,
      allowStaleOnMismatch,
      skipCacheRead,
      accountId: context.accountId,
    }),
    listWorkspaceAccessPolicies(ctx, context.workspaceId, context.accountId),
  ]);
  const descriptorsStartedAt = Date.now();
  const tools = listVisibleToolDescriptors(result.tools, context, policies, {
    includeDetails,
    toolPaths: options.toolPaths,
  });
  const descriptorsMs = Date.now() - descriptorsStartedAt;
  let sourceQuality: Record<string, OpenApiSourceQuality> = {};
  let sourceAuthProfiles: Record<string, SourceAuthProfile> = {};
  let qualityMs = 0;
  let authProfilesMs = 0;

  if (includeSourceMeta) {
    const qualityStartedAt = Date.now();
    sourceQuality = computeOpenApiSourceQuality(result.tools);
    qualityMs = Date.now() - qualityStartedAt;
    const authProfilesStartedAt = Date.now();
    sourceAuthProfiles = computeSourceAuthProfiles(result.tools);
    authProfilesMs = Date.now() - authProfilesStartedAt;
  }

  const sourceMetaTrace = includeSourceMeta
    ? [
        `computeOpenApiSourceQuality=${qualityMs}ms`,
        `computeSourceAuthProfiles=${authProfilesMs}ms`,
      ]
    : ["sourceMeta=skipped"];

  let typesUrl: string | undefined;
  if (result.typesStorageId) {
    try {
      typesUrl = await ctx.storage.getUrl(result.typesStorageId) ?? undefined;
    } catch {
      typesUrl = undefined;
    }
  }

  const { tools: boundedTools, warnings: boundedWarnings } = truncateToolsForActionResult(
    tools,
    result.warnings,
  );

  return {
    tools: boundedTools,
    warnings: boundedWarnings,
    typesUrl,
    sourceQuality,
    sourceAuthProfiles,
    debug: {
      ...result.debug,
      trace: [
        ...result.debug.trace,
        `listVisibleToolDescriptors=${descriptorsMs}ms`,
        ...sourceMetaTrace,
      ],
    },
  };
}

export async function listToolsForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
  options: {
    includeDetails?: boolean;
    includeSourceMeta?: boolean;
    toolPaths?: string[];
    sourceTimeoutMs?: number;
    allowStaleOnMismatch?: boolean;
    skipCacheRead?: boolean;
  } = {},
): Promise<ToolDescriptor[]> {
  const inventory = await loadWorkspaceToolInventoryForContext(ctx, context, options);
  return inventory.tools;
}

export async function listToolsWithWarningsForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
  options: {
    includeDetails?: boolean;
    includeSourceMeta?: boolean;
    toolPaths?: string[];
    sourceTimeoutMs?: number;
    allowStaleOnMismatch?: boolean;
    skipCacheRead?: boolean;
  } = {},
): Promise<{
  tools: ToolDescriptor[];
  warnings: string[];
  typesUrl?: string;
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  debug: WorkspaceToolsDebug;
}> {
  const inventory = await loadWorkspaceToolInventoryForContext(ctx, context, options);
  return {
    tools: inventory.tools,
    warnings: inventory.warnings,
    typesUrl: inventory.typesUrl,
    sourceQuality: inventory.sourceQuality,
    sourceAuthProfiles: inventory.sourceAuthProfiles,
    debug: inventory.debug,
  };
}

export { baseTools };
