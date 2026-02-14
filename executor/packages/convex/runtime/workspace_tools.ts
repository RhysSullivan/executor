"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createCatalogTools, createDiscoverTool } from "../../core/src/tool-discovery";
import {
  materializeCompiledToolSource,
  materializeWorkspaceSnapshot,
  type CompiledToolSourceArtifact,
  type WorkspaceToolSnapshot,
} from "../../core/src/tool-sources";
import type { ExternalToolSourceConfig } from "../../core/src/tool-source-types";
import type {
  AccessPolicyRecord,
  OpenApiSourceQuality,
  SourceAuthProfile,
  ToolDefinition,
  ToolDescriptor,
} from "../../core/src/types";
import { computeOpenApiSourceQuality, listVisibleToolDescriptors } from "./tool_descriptors";
import { loadSourceArtifact, normalizeExternalToolSource, sourceSignature } from "./tool_source_loading";

const baseTools = new Map<string, ToolDefinition>();

interface DtsStorageEntry {
  sourceKey: string;
  storageId: Id<"_storage">;
}

interface WorkspaceToolsResult {
  tools: Map<string, ToolDefinition>;
  warnings: string[];
  dtsStorageIds: DtsStorageEntry[];
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
  includeDts?: boolean;
  sourceTimeoutMs?: number;
  allowStaleOnMismatch?: boolean;
  skipCacheRead?: boolean;
  actorId?: string;
}

interface WorkspaceToolInventory {
  tools: ToolDescriptor[];
  warnings: string[];
  dtsStorageIds: DtsStorageEntry[];
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

function mergeToolsWithCatalog(externalTools: Iterable<ToolDefinition>): Map<string, ToolDefinition> {
  const merged = new Map<string, ToolDefinition>();

  for (const tool of baseTools.values()) {
    if (tool.path === "discover") continue;
    merged.set(tool.path, tool);
  }

  for (const tool of externalTools) {
    if (tool.path === "discover") continue;
    merged.set(tool.path, tool);
  }

  const catalogTools = createCatalogTools([...merged.values()]);
  for (const tool of catalogTools) {
    merged.set(tool.path, tool);
  }

  const discover = createDiscoverTool([...merged.values()]);
  merged.set(discover.path, discover);
  return merged;
}

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
  const includeDts = options.includeDts ?? false;
  const sourceTimeoutMs = options.sourceTimeoutMs;
  const allowStaleOnMismatch = options.allowStaleOnMismatch ?? false;
  const actorId = options.actorId;
  const sources = (await ctx.runQuery(internal.database.listToolSources, { workspaceId }))
    .filter((source: { enabled: boolean }) => source.enabled);
  const hasActorScopedMcpSource = sources.some((source: { type: string; config: Record<string, unknown> }) => {
    if (source.type !== "mcp") {
      return false;
    }
    const auth = source.config.auth as Record<string, unknown> | undefined;
    return auth?.mode === "actor";
  });
  const skipCacheRead = (options.skipCacheRead ?? false) || hasActorScopedMcpSource;
  const skipCacheWrite = hasActorScopedMcpSource;
  traceStep("listToolSources", listSourcesStartedAt);
  const hasOpenApiSource = sources.some((source: { type: string }) => source.type === "openapi");
  const signature = sourceSignature(workspaceId, sources);
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
        const snapshot = JSON.parse(await blob.text()) as WorkspaceToolSnapshot;
        const restored = materializeWorkspaceSnapshot(snapshot);
        const merged = mergeToolsWithCatalog(restored);
        traceStep("cacheHydrate", cacheHydrateStartedAt);

        const dtsStorageIds = (cacheEntry.dtsStorageIds ?? []) as DtsStorageEntry[];
        if (cacheEntry.isFresh) {
          const hasCachedDts = dtsStorageIds.length > 0;
          if (includeDts && hasOpenApiSource && !hasCachedDts) {
            // Continue into rebuild path to generate missing DTS.
          } else {
            return {
              tools: merged,
              warnings: snapshot.warnings,
              dtsStorageIds,
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
        } else if (allowStaleOnMismatch && !includeDts) {
          return {
            tools: merged,
            warnings: [...snapshot.warnings, "Tool sources changed; showing previous results while refreshing."],
            dtsStorageIds,
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
    try {
      configs.push(normalizeExternalToolSource(source));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Source '${source.name}': ${message}`);
    }
  }
  traceStep("normalizeSources", normalizeSourcesStartedAt);

  const loadSourcesStartedAt = Date.now();
  const loadedSources = await Promise.all(configs.map(async (config) => {
    if (!sourceTimeoutMs || sourceTimeoutMs <= 0) {
      return {
        ...(await loadSourceArtifact(ctx, config, { includeDts, workspaceId, actorId })),
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
    }>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          artifact: undefined,
          warnings: [`Source '${config.name}' is still loading; showing partial results.`],
          timedOut: true,
          sourceName: config.name,
        });
      }, sourceTimeoutMs);
    });

    const loadResult = loadSourceArtifact(ctx, config, { includeDts, workspaceId, actorId })
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
  const merged = mergeToolsWithCatalog(externalTools);

  let dtsStorageIds: DtsStorageEntry[] = [];
  try {
    if (hasTimedOutSource) {
      return {
        tools: merged,
        warnings,
        dtsStorageIds,
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

    const seenDtsSources = new Set<string>();
    const dtsEntries: { sourceKey: string; content: string }[] = [];
    for (const artifact of externalArtifacts) {
      for (const tool of artifact.tools) {
        if (tool.metadata?.sourceDts && tool.source && !seenDtsSources.has(tool.source)) {
          seenDtsSources.add(tool.source);
          dtsEntries.push({ sourceKey: tool.source, content: tool.metadata.sourceDts });
        }
      }
    }

    const storedDts = await Promise.all(
      dtsEntries.map(async (entry) => {
        const dtsBlob = new Blob([entry.content], { type: "text/plain" });
        const sid = await ctx.storage.store(dtsBlob);
        return { sourceKey: entry.sourceKey, storageId: sid };
      }),
    );
    dtsStorageIds = storedDts;

    const sanitizedArtifacts: CompiledToolSourceArtifact[] = externalArtifacts.map((artifact) => ({
      ...artifact,
      tools: artifact.tools.map((tool) => {
        if (!tool.metadata?.sourceDts) return tool;
        const metadata = { ...tool.metadata };
        delete (metadata as Record<string, unknown>).sourceDts;
        return { ...tool, metadata };
      }),
    }));

    const snapshot: WorkspaceToolSnapshot = {
      version: "v2",
      externalArtifacts: sanitizedArtifacts,
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
        dtsStorageIds: storedDts.map((e) => ({ sourceKey: e.sourceKey, storageId: e.storageId })),
        toolCount: allTools.length,
        sizeBytes: json.length,
      });
      traceStep("snapshotWrite", snapshotWriteStartedAt);
    } else {
      trace.push("snapshotWrite=skipped(actor-scoped-mcp)");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] workspace tool cache write failed for '${workspaceId}': ${msg}`);
  }

  return {
    tools: merged,
    warnings,
    dtsStorageIds,
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
  context: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string },
  options: {
    includeDts?: boolean;
    includeDetails?: boolean;
    includeSourceMeta?: boolean;
    toolPaths?: string[];
    sourceTimeoutMs?: number;
    allowStaleOnMismatch?: boolean;
    skipCacheRead?: boolean;
  } = {},
): Promise<WorkspaceToolInventory> {
  const includeDts = options.includeDts ?? false;
  const includeDetails = options.includeDetails ?? true;
  const includeSourceMeta = options.includeSourceMeta ?? true;
  const sourceTimeoutMs = options.sourceTimeoutMs;
  const allowStaleOnMismatch = options.allowStaleOnMismatch;
  const skipCacheRead = options.skipCacheRead;
  const [result, policies] = await Promise.all([
    getWorkspaceTools(ctx, context.workspaceId, {
      includeDts,
      sourceTimeoutMs,
      allowStaleOnMismatch,
      skipCacheRead,
      actorId: context.actorId,
    }),
    ctx.runQuery(internal.database.listAccessPolicies, { workspaceId: context.workspaceId }),
  ]);
  const typedPolicies = policies as AccessPolicyRecord[];
  const descriptorsStartedAt = Date.now();
  const tools = listVisibleToolDescriptors(result.tools, context, typedPolicies, {
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

  const { tools: boundedTools, warnings: boundedWarnings } = truncateToolsForActionResult(
    tools,
    result.warnings,
  );

  return {
    tools: boundedTools,
    warnings: boundedWarnings,
    dtsStorageIds: result.dtsStorageIds,
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
  context: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string },
  options: {
    includeDts?: boolean;
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
  context: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string },
  options: {
    includeDts?: boolean;
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
  dtsUrls: Record<string, string>;
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  debug: WorkspaceToolsDebug;
}> {
  const inventory = await loadWorkspaceToolInventoryForContext(ctx, context, options);
  const dtsUrls = await loadDtsUrls(ctx, inventory.dtsStorageIds);

  return {
    tools: inventory.tools,
    warnings: inventory.warnings,
    dtsUrls,
    sourceQuality: inventory.sourceQuality,
    sourceAuthProfiles: inventory.sourceAuthProfiles,
    debug: inventory.debug,
  };
}

export async function loadDtsUrls(ctx: ActionCtx, entries: DtsStorageEntry[]): Promise<Record<string, string>> {
  if (entries.length === 0) return {};

  const urlEntries = await Promise.all(entries.map(async (entry) => {
    try {
      const url = await ctx.storage.getUrl(entry.storageId);
      return url ? [entry.sourceKey, url] as const : null;
    } catch {
      return null;
    }
  }));

  const dtsUrls: Record<string, string> = {};
  for (const pair of urlEntries) {
    if (!pair) continue;
    const [sourceKey, url] = pair;
    dtsUrls[sourceKey] = url;
  }

  return dtsUrls;
}

export async function loadWorkspaceDtsStorageIds(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<DtsStorageEntry[]> {
  const sources = (await ctx.runQuery(internal.database.listToolSources, { workspaceId }))
    .filter((source: { enabled: boolean }) => source.enabled);
  const hasOpenApiSource = sources.some((source: { type: string }) => source.type === "openapi");
  const signature = sourceSignature(workspaceId, sources);

  try {
    const cacheEntry = await ctx.runQuery(internal.workspaceToolCache.getEntry, {
      workspaceId,
      signature,
    });
    if (cacheEntry) {
      const dtsStorageIds = (cacheEntry.dtsStorageIds ?? []) as DtsStorageEntry[];
      if (dtsStorageIds.length > 0 || !hasOpenApiSource) {
        return dtsStorageIds;
      }
    }
  } catch {
    // Fall through to a full rebuild path.
  }

  const rebuilt = await getWorkspaceTools(ctx, workspaceId, { includeDts: true });
  return rebuilt.dtsStorageIds;
}

export { baseTools };
