"use node";

import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { internal } from "../../convex/_generated/api";
import { sourceSignature } from "./tool_source_loading";

export const TOOL_REGISTRY_SIGNATURE_PREFIX = "toolreg_v2|";

export function registrySignatureForWorkspace(
  workspaceId: Id<"workspaces">,
  sources: Array<{ id: string; updatedAt: number; enabled: boolean }>,
): string {
  const enabledSources = sources.filter((source) => source.enabled);
  return `${TOOL_REGISTRY_SIGNATURE_PREFIX}${sourceSignature(workspaceId, enabledSources)}`;
}

type RegistryState = {
  signature: string;
  readyBuildId?: string;
} | null;

type ToolSourceState = {
  id: string;
  updatedAt: number;
  enabled: boolean;
};

const registryStateSchema = z.object({
  signature: z.string(),
  readyBuildId: z.string().optional(),
});

const toolSourceStateSchema = z.object({
  id: z.string(),
  updatedAt: z.number(),
  enabled: z.boolean().optional(),
});

function toRegistryState(value: unknown): RegistryState {
  const parsed = registryStateSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return {
    signature: parsed.data.signature,
    readyBuildId: parsed.data.readyBuildId,
  };
}

function toToolSourceStateList(value: unknown): ToolSourceState[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ToolSourceState[] = [];
  for (const entry of value) {
    const parsed = toolSourceStateSchema.safeParse(entry);
    if (!parsed.success) continue;

    normalized.push({
      id: parsed.data.id,
      updatedAt: parsed.data.updatedAt,
      enabled: parsed.data.enabled !== false,
    });
  }

  return normalized;
}

async function readRegistryState(
  ctx: Pick<ActionCtx, "runQuery">,
  workspaceId: Id<"workspaces">,
): Promise<{ buildId?: string; isReady: boolean }> {
  const [rawState, rawSources] = await Promise.all([
    ctx.runQuery(internal.toolRegistry.getState, { workspaceId }),
    ctx.runQuery(internal.database.listToolSources, { workspaceId }),
  ]);
  const state = toRegistryState(rawState);
  const sources = toToolSourceStateList(rawSources);

  const expectedSignature = registrySignatureForWorkspace(workspaceId, sources);
  const buildId = state?.readyBuildId;

  return {
    buildId,
    isReady: Boolean(buildId && state?.signature === expectedSignature),
  };
}

export async function getReadyRegistryBuildId(
  ctx: Pick<ActionCtx, "runQuery" | "runAction">,
  args: {
    workspaceId: Id<"workspaces">;
    actorId?: string;
    clientId?: string;
    refreshOnStale?: boolean;
  },
): Promise<string> {
  const initial = await readRegistryState(ctx, args.workspaceId);
  if (initial.isReady && initial.buildId) {
    return initial.buildId;
  }

  if (args.refreshOnStale) {
    await ctx.runAction(internal.executorNode.listToolsWithWarningsInternal, {
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      clientId: args.clientId,
    });

    const refreshed = await readRegistryState(ctx, args.workspaceId);
    if (refreshed.isReady && refreshed.buildId) {
      return refreshed.buildId;
    }
  }

  throw new Error(
    "Tool registry is not ready (or is stale). Open Tools to refresh, or call listToolsWithWarnings to rebuild.",
  );
}
