"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createDiscoverTool } from "../../core/src/tool-discovery";
import {
  materializeCompiledToolSource,
  materializeWorkspaceSnapshot,
  type CompiledToolSourceArtifact,
  type ExternalToolSourceConfig,
  type WorkspaceToolSnapshot,
} from "../../core/src/tool-sources";
import { DEFAULT_TOOLS } from "../../core/src/tools";
import type {
  AccessPolicyRecord,
  OpenApiSourceQuality,
  SourceAuthProfile,
  ToolDefinition,
  ToolDescriptor,
} from "../../core/src/types";
import { computeOpenApiSourceQuality, listVisibleToolDescriptors } from "./tool_descriptors";
import { loadSourceArtifact, normalizeExternalToolSource, sourceSignature } from "./tool_source_loading";

const baseTools = new Map<string, ToolDefinition>(DEFAULT_TOOLS.map((tool) => [tool.path, tool]));

export interface DtsStorageEntry {
  sourceKey: string;
  storageId: Id<"_storage">;
}

export interface WorkspaceToolsResult {
  tools: Map<string, ToolDefinition>;
  warnings: string[];
  dtsStorageIds: DtsStorageEntry[];
}

export interface WorkspaceToolInventory {
  tools: ToolDescriptor[];
  warnings: string[];
  dtsStorageIds: DtsStorageEntry[];
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
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

export async function getWorkspaceTools(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<WorkspaceToolsResult> {
  const sources = (await ctx.runQuery(internal.database.listToolSources, { workspaceId }))
    .filter((source: { enabled: boolean }) => source.enabled);
  const signature = sourceSignature(workspaceId, sources);

  try {
    const cacheEntry = await ctx.runQuery(internal.workspaceToolCache.getEntry, {
      workspaceId,
      signature,
    });

    if (cacheEntry) {
      const blob = await ctx.storage.get(cacheEntry.storageId);
      if (blob) {
        const snapshot = JSON.parse(await blob.text()) as WorkspaceToolSnapshot;
        const restored = materializeWorkspaceSnapshot(snapshot);

        const merged = new Map<string, ToolDefinition>();
        for (const tool of baseTools.values()) {
          if (tool.path === "discover") continue;
          merged.set(tool.path, tool);
        }
        for (const tool of restored) {
          if (tool.path === "discover") continue;
          merged.set(tool.path, tool);
        }
        const discover = createDiscoverTool([...merged.values()]);
        merged.set(discover.path, discover);

        const dtsStorageIds = (cacheEntry.dtsStorageIds ?? []) as DtsStorageEntry[];

        return { tools: merged, warnings: snapshot.warnings, dtsStorageIds };
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] workspace tool cache read failed for '${workspaceId}': ${msg}`);
  }

  const configs: ExternalToolSourceConfig[] = [];
  const warnings: string[] = [];
  for (const source of sources) {
    try {
      configs.push(normalizeExternalToolSource(source));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Source '${source.name}': ${message}`);
    }
  }

  const loadedSources = await Promise.all(configs.map((config) => loadSourceArtifact(ctx, config)));
  const externalArtifacts = loadedSources
    .map((loaded) => loaded.artifact)
    .filter((artifact): artifact is CompiledToolSourceArtifact => Boolean(artifact));
  const externalTools = externalArtifacts.flatMap((artifact) => materializeCompiledToolSource(artifact));
  warnings.push(...loadedSources.flatMap((loaded) => loaded.warnings));

  const merged = new Map<string, ToolDefinition>();
  for (const tool of baseTools.values()) {
    if (tool.path === "discover") continue;
    merged.set(tool.path, tool);
  }
  for (const tool of externalTools) {
    merged.set(tool.path, tool);
  }

  const discover = createDiscoverTool([...merged.values()]);
  merged.set(discover.path, discover);

  let dtsStorageIds: DtsStorageEntry[] = [];
  try {
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] workspace tool cache write failed for '${workspaceId}': ${msg}`);
  }

  return { tools: merged, warnings, dtsStorageIds };
}

export async function loadWorkspaceToolInventoryForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string },
): Promise<WorkspaceToolInventory> {
  const [result, policies] = await Promise.all([
    getWorkspaceTools(ctx, context.workspaceId),
    ctx.runQuery(internal.database.listAccessPolicies, { workspaceId: context.workspaceId }),
  ]);
  const typedPolicies = policies as AccessPolicyRecord[];
  const tools = listVisibleToolDescriptors(result.tools, context, typedPolicies);
  const sourceQuality = computeOpenApiSourceQuality(result.tools);
  const sourceAuthProfiles = computeSourceAuthProfiles(result.tools);

  return {
    tools,
    warnings: result.warnings,
    dtsStorageIds: result.dtsStorageIds,
    sourceQuality,
    sourceAuthProfiles,
  };
}

export async function listToolsForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string },
): Promise<ToolDescriptor[]> {
  const inventory = await loadWorkspaceToolInventoryForContext(ctx, context);
  return inventory.tools;
}

export async function listToolsWithWarningsForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string },
): Promise<{
  tools: ToolDescriptor[];
  warnings: string[];
  dtsUrls: Record<string, string>;
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
}> {
  const inventory = await loadWorkspaceToolInventoryForContext(ctx, context);
  const dtsUrls = await loadDtsUrls(ctx, inventory.dtsStorageIds);

  return {
    tools: inventory.tools,
    warnings: inventory.warnings,
    dtsUrls,
    sourceQuality: inventory.sourceQuality,
    sourceAuthProfiles: inventory.sourceAuthProfiles,
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
  const signature = sourceSignature(workspaceId, sources);

  try {
    const cacheEntry = await ctx.runQuery(internal.workspaceToolCache.getEntry, {
      workspaceId,
      signature,
    });
    if (cacheEntry) {
      return (cacheEntry.dtsStorageIds ?? []) as DtsStorageEntry[];
    }
  } catch {
    // Fall through to a full rebuild path.
  }

  const rebuilt = await getWorkspaceTools(ctx, workspaceId);
  return rebuilt.dtsStorageIds;
}

export { baseTools };
