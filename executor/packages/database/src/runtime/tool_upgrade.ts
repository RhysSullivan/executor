import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import type { ToolSourceRecord } from "../../../core/src/types";
import { normalizeExternalToolSource, loadSourceArtifact } from "./tool_source_loading";

export interface OpenApiUpgradeDiffPreview {
  sourceId: string;
  currentSourceName: string;
  proposedSourceName: string;
  currentToolCount: number;
  proposedToolCount: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  hasChanges: boolean;
  addedPaths: string[];
  removedPaths: string[];
  changedPaths: string[];
  truncated: boolean;
  warnings: string[];
}

const PREVIEW_LIST_LIMIT = 200;

function clampPreview(items: string[]): { items: string[]; truncated: boolean } {
  if (items.length <= PREVIEW_LIST_LIMIT) {
    return { items, truncated: false };
  }

  return {
    items: items.slice(0, PREVIEW_LIST_LIMIT),
    truncated: true,
  };
}

async function listCurrentSourceToolMap(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  sourceLabel: string,
): Promise<Map<string, string>> {
  const tools = new Map<string, string>();
  let cursor: string | undefined;

  while (true) {
    const page: {
      continueCursor: string | null;
      items: Array<{ path: string }>;
    } = await ctx.runQuery(internal.toolRegistry.listToolsBySourcePage, {
      workspaceId,
      source: sourceLabel,
      cursor,
      limit: 500,
    });

    const payloads: Array<{ path: string; serializedToolJson: string }> = await ctx.runQuery(
      internal.toolRegistry.getSerializedToolsByPaths,
      {
        workspaceId,
        paths: page.items.map((item) => item.path),
      },
    );

    for (const payload of payloads) {
      tools.set(payload.path, payload.serializedToolJson);
    }

    if (page.continueCursor === null) {
      break;
    }

    cursor = page.continueCursor;
  }

  return tools;
}

export async function previewOpenApiSourceUpgradeForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
  args: { sourceId: string; name: string; config: Record<string, unknown> },
): Promise<OpenApiUpgradeDiffPreview> {
  const sources: ToolSourceRecord[] = await ctx.runQuery(internal.database.listToolSources, {
    workspaceId: context.workspaceId,
  });
  const existing = sources.find((source) => source.id === args.sourceId);
  if (!existing) {
    throw new Error("Source not found");
  }
  if (existing.type !== "openapi") {
    throw new Error("Upgrade preview is only supported for OpenAPI sources");
  }

  const candidateName = args.name.trim();
  if (!candidateName) {
    throw new Error("Source name is required");
  }

  const candidateSource: ToolSourceRecord = {
    ...existing,
    name: candidateName,
    type: "openapi",
    config: args.config,
    enabled: true,
    updatedAt: Date.now(),
  };

  const normalized = normalizeExternalToolSource(candidateSource);
  if (normalized.isErr()) {
    throw new Error(normalized.error.message);
  }

  if (normalized.value.type !== "openapi") {
    throw new Error("Upgrade preview expects an OpenAPI source");
  }

  const loaded = await loadSourceArtifact(ctx, normalized.value, {
    includeDts: false,
    workspaceId: context.workspaceId,
    accountId: context.accountId,
  });

  const proposedSerializedTools = loaded.artifact?.tools ?? [];
  if (!loaded.artifact) {
    const reason = loaded.warnings[0] ?? "No tools generated from proposed spec";
    throw new Error(reason);
  }

  const proposedByPath = new Map<string, string>();
  for (const tool of proposedSerializedTools) {
    proposedByPath.set(tool.path, JSON.stringify(tool));
  }

  const currentByPath = await listCurrentSourceToolMap(
    ctx,
    context.workspaceId,
    `openapi:${existing.name}`,
  );

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [path, serialized] of proposedByPath.entries()) {
    const current = currentByPath.get(path);
    if (!current) {
      added.push(path);
      continue;
    }
    if (current !== serialized) {
      changed.push(path);
    }
  }

  for (const path of currentByPath.keys()) {
    if (!proposedByPath.has(path)) {
      removed.push(path);
    }
  }

  added.sort((a, b) => a.localeCompare(b));
  removed.sort((a, b) => a.localeCompare(b));
  changed.sort((a, b) => a.localeCompare(b));

  const cappedAdded = clampPreview(added);
  const cappedRemoved = clampPreview(removed);
  const cappedChanged = clampPreview(changed);

  return {
    sourceId: existing.id,
    currentSourceName: existing.name,
    proposedSourceName: candidateName,
    currentToolCount: currentByPath.size,
    proposedToolCount: proposedByPath.size,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
    addedPaths: cappedAdded.items,
    removedPaths: cappedRemoved.items,
    changedPaths: cappedChanged.items,
    truncated: cappedAdded.truncated || cappedRemoved.truncated || cappedChanged.truncated,
    warnings: loaded.warnings,
  };
}
