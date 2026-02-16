"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { useAction, useQuery as useConvexQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type { OpenApiSourceQuality, SourceAuthProfile, ToolDescriptor } from "@/lib/types";
import type { Id } from "@executor/database/convex/_generated/dataModel";

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
  /** URL to a workspace-wide Monaco `.d.ts` bundle (may be undefined). */
  typesUrl?: string;
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

interface UseWorkspaceToolsOptions {
  includeDetails?: boolean;
}

/**
 * Fetches tool metadata from a Convex action, cached by TanStack Query.
 *
 * Automatically re-fetches when the Convex `toolSources` subscription changes
 * (the reactive value is included in the query key).
 */
export function useWorkspaceTools(
  context: WorkspaceContext | null,
  options: UseWorkspaceToolsOptions = {},
) {
  const includeDetails = options.includeDetails ?? true;
  const listToolsWithWarningsRaw = useAction(convexApi.executorNode.listToolsWithWarnings);
  const listToolsWithWarnings = listToolsWithWarningsRaw as unknown as (args: Record<string, unknown>) => Promise<WorkspaceToolsQueryResult>;
  const detailsCacheRef = useRef<Map<string, ToolDescriptor>>(new Map());

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
      includeDetails,
      toolSources,
    ],
    queryFn: async (): Promise<WorkspaceToolsQueryResult> => {
      if (!context) {
        return {
          tools: [],
          warnings: [],
          sourceQuality: {},
          sourceAuthProfiles: {},
          typesUrl: undefined,
        };
      }
      return await listToolsWithWarnings({
        workspaceId: context.workspaceId,
        ...(context.actorId && { actorId: context.actorId }),
        ...(context.clientId && { clientId: context.clientId }),
        ...(context.sessionId && { sessionId: context.sessionId }),
        includeDetails,
      });
    },
    enabled: !!context,
    refetchInterval: (query) => {
      const data = query.state.data as WorkspaceToolsQueryResult | undefined;
      const warnings = data?.warnings ?? [];
      const hasPendingSource = warnings.some((warning) => warning.includes("still loading"));
      const hasStaleInventory = warnings.some((warning) =>
        warning.includes("showing previous results while refreshing"),
      );
      return hasPendingSource || hasStaleInventory ? 2_000 : false;
    },
    placeholderData: (previousData) => previousData,
  });

  const loadToolDetails = useCallback(async (toolPaths: string[]): Promise<Record<string, ToolDescriptor>> => {
    const requested = [...new Set(toolPaths.filter((path) => path.length > 0))];
    if (requested.length === 0) {
      return {};
    }

    const cache = detailsCacheRef.current;
    const missing = requested.filter((path) => !cache.has(path));
    if (missing.length > 0) {
      if (!context) {
        return {};
      }

      const detailedInventory = await listToolsWithWarnings({
        workspaceId: context.workspaceId,
        ...(context.actorId && { actorId: context.actorId }),
        ...(context.clientId && { clientId: context.clientId }),
        ...(context.sessionId && { sessionId: context.sessionId }),
        includeDetails: true,
        includeSourceMeta: false,
        toolPaths: missing,
      });

      for (const tool of detailedInventory.tools) {
        cache.set(tool.path, tool);
      }
    }

    const result: Record<string, ToolDescriptor> = {};
    for (const path of requested) {
      const tool = cache.get(path);
      if (tool) {
        result[path] = tool;
      }
    }
    return result;
  }, [context, listToolsWithWarnings]);

  useEffect(() => {
    detailsCacheRef.current.clear();
  }, [context?.workspaceId, context?.actorId, context?.clientId, context?.sessionId]);

  useEffect(() => {
    if (!inventoryData || !includeDetails) {
      return;
    }
    const cache = detailsCacheRef.current;
    for (const tool of inventoryData.tools) {
      cache.set(tool.path, tool);
    }
  }, [inventoryData, includeDetails]);

  return {
    tools: inventoryData?.tools ?? [],
    warnings: inventoryData?.warnings ?? [],
    /** Workspace-wide Monaco `.d.ts` bundle URL (may be undefined). */
    typesUrl: inventoryData?.typesUrl,
    /** Per-source OpenAPI quality metrics (unknown/fallback type rates). */
    sourceQuality: inventoryData?.sourceQuality ?? {},
    sourceAuthProfiles: inventoryData?.sourceAuthProfiles ?? {},
    debug: inventoryData?.debug,
    loadingSources: inventoryData?.debug?.timedOutSources ?? [],
    loadingTools: !!context && toolsLoading,
    refreshingTools: !!context && toolsFetching,
    // Backward compatibility for callers that still use a single loading state.
    loading: !!context && toolsLoading,
    loadToolDetails,
  };
}
