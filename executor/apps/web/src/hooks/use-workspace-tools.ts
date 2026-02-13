"use client";

import { useEffect } from "react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { useAction, useQuery as useConvexQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type { OpenApiSourceQuality, SourceAuthProfile, ToolDescriptor, ToolSourceRecord } from "@/lib/types";
import type { Id } from "@executor/convex/_generated/dataModel";

interface WorkspaceContext {
  workspaceId: Id<"workspaces">;
  actorId?: string;
  clientId?: string;
  sessionId?: string;
}

interface WorkspaceToolsQueryResult {
  tools: ToolDescriptor[];
  warnings: string[];
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  debug?: {
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
  };
}

interface WorkspaceToolDtsResult {
  dtsUrls: Record<string, string>;
}

/**
 * Fetches tool metadata from a Convex action, cached by TanStack Query.
 *
 * Automatically re-fetches when the Convex `toolSources` subscription changes
 * (the reactive value is included in the query key).
 */
export function useWorkspaceTools(context: WorkspaceContext | null) {
  const listToolsWithWarnings = useAction(convexApi.executorNode.listToolsWithWarnings);
  const listToolDtsUrls = useAction(convexApi.executorNode.listToolDtsUrls);

  // Watch tool sources reactively so we invalidate when sources change
  const toolSources = useConvexQuery(
    convexApi.workspace.listToolSources,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
  );

  const {
    data: inventoryData,
    isLoading: toolsLoading,
    isFetching: toolsFetching,
  } = useTanstackQuery({
    queryKey: [
      "workspace-tools-inventory",
      context?.workspaceId,
      context?.actorId,
      context?.clientId,
      toolSources,
    ],
    queryFn: async (): Promise<WorkspaceToolsQueryResult> => {
      if (!context) {
        return { tools: [], warnings: [], sourceQuality: {}, sourceAuthProfiles: {} };
      }
      return await listToolsWithWarnings({
        workspaceId: context.workspaceId,
        ...(context.actorId && { actorId: context.actorId }),
        ...(context.clientId && { clientId: context.clientId }),
        ...(context.sessionId && { sessionId: context.sessionId }),
      });
    },
    enabled: !!context,
    refetchInterval: (query) => {
      const data = query.state.data as WorkspaceToolsQueryResult | undefined;
      const hasPendingSource = (data?.warnings ?? []).some((warning) => warning.includes("still loading"));
      return hasPendingSource ? 2_000 : false;
    },
    placeholderData: (previousData) => previousData,
  });

  const hasOpenApiSource = (toolSources ?? []).some(
    (source: ToolSourceRecord) => source.type === "openapi" && source.enabled,
  );

  useEffect(() => {
    if (!inventoryData?.debug) return;
    console.debug("[tools-debug] inventory", {
      mode: inventoryData.debug.mode,
      durationMs: inventoryData.debug.durationMs,
      cacheHit: inventoryData.debug.cacheHit,
      cacheFresh: inventoryData.debug.cacheFresh,
      skipCacheRead: inventoryData.debug.skipCacheRead,
      sourceCount: inventoryData.debug.sourceCount,
      normalizedSourceCount: inventoryData.debug.normalizedSourceCount,
      timedOutSources: inventoryData.debug.timedOutSources,
      trace: inventoryData.debug.trace,
      warningCount: inventoryData.warnings.length,
      toolCount: inventoryData.tools.length,
    });
  }, [inventoryData]);

  const { data: dtsData, isLoading: dtsLoading } = useTanstackQuery({
    queryKey: [
      "workspace-tools-dts",
      context?.workspaceId,
      context?.actorId,
      toolSources,
    ],
    queryFn: async (): Promise<WorkspaceToolDtsResult> => {
      if (!context) {
        return { dtsUrls: {} };
      }
      return await listToolDtsUrls({
        workspaceId: context.workspaceId,
        ...(context.actorId && { actorId: context.actorId }),
        ...(context.sessionId && { sessionId: context.sessionId }),
      });
    },
    enabled: !!context && !!inventoryData && hasOpenApiSource,
    placeholderData: (previousData) => previousData,
  });

  return {
    tools: inventoryData?.tools ?? [],
    warnings: inventoryData?.warnings ?? [],
    /** Per-source .d.ts download URLs for Monaco IntelliSense. Keyed by source key (e.g. "openapi:cloudflare"). */
    dtsUrls: dtsData?.dtsUrls ?? {},
    /** Per-source OpenAPI quality metrics (unknown/fallback type rates). */
    sourceQuality: inventoryData?.sourceQuality ?? {},
    sourceAuthProfiles: inventoryData?.sourceAuthProfiles ?? {},
    debug: inventoryData?.debug,
    loadingTools: !!context && toolsLoading,
    refreshingTools: !!context && toolsFetching,
    loadingTypes: !!context && hasOpenApiSource && !!inventoryData && dtsLoading,
    // Backward compatibility for callers that still use a single loading state.
    loading: !!context && toolsLoading,
  };
}
