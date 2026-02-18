"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAction, useMutation, useQuery as useConvexQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type { OpenApiSourceQuality, SourceAuthProfile, ToolDescriptor } from "@/lib/types";
import type { Id } from "@executor/database/convex/_generated/dataModel";

interface WorkspaceContext {
  workspaceId: Id<"workspaces">;
  accountId?: string;
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
  inventoryStatus: {
    state: "initializing" | "ready" | "rebuilding" | "stale" | "failed";
    readyBuildId?: string;
    buildingBuildId?: string;
    readyToolCount: number;
    loadingSourceNames: string[];
    sourceToolCounts: Record<string, number>;
    lastBuildStartedAt?: number;
    lastBuildCompletedAt?: number;
    lastBuildFailedAt?: number;
    error?: string;
    updatedAt?: number;
  };
  nextCursor?: string | null;
  totalTools: number;
}

interface UseWorkspaceToolsOptions {
  includeDetails?: boolean;
}

type ToolDetailDescriptor = Pick<ToolDescriptor, "path" | "description" | "display" | "typing">;

type GetToolDetailsMutation = (args: {
  workspaceId: Id<"workspaces">;
  sessionId?: string;
  toolPaths: string[];
}) => Promise<Record<string, ToolDetailDescriptor>>;

type ListToolsWithWarningsAction = (args: {
  workspaceId: Id<"workspaces">;
  accountId?: string;
  sessionId?: string;
  includeDetails?: boolean;
  includeSourceMeta?: boolean;
  toolPaths?: string[];
  source?: string;
  sourceName?: string;
  cursor?: string;
  limit?: number;
  buildId?: string;
  fetchAll?: boolean;
  rebuildInventory?: boolean;
}) => Promise<WorkspaceToolsQueryResult>;

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
  const includeDetails = options.includeDetails ?? false;
  const listToolsWithWarningsRaw = useAction(convexApi.executorNode.listToolsWithWarnings);
  const listToolsWithWarnings = listToolsWithWarningsRaw as ListToolsWithWarningsAction;
  const listToolDetailsRaw = useMutation(convexApi.workspace.getToolDetails);
  const listToolDetails = listToolDetailsRaw as GetToolDetailsMutation;
  const detailsCacheRef = useRef<Map<string, ToolDetailDescriptor>>(new Map());

  // Watch inventory progress reactively so we invalidate when generation state changes.
  const inventoryProgress = useConvexQuery(
    convexApi.workspace.getToolInventoryProgress,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
  );

  const inventoryQuery = useQuery<WorkspaceToolsQueryResult, Error>({
    queryKey: [
      "workspace-tools-inventory",
      context?.workspaceId,
      context?.accountId,
      context?.clientId,
      includeDetails,
      inventoryProgress?.reactiveKey,
    ],
    queryFn: async (): Promise<WorkspaceToolsQueryResult> => {
      if (!context) {
        return {
          tools: [],
          warnings: [],
          sourceQuality: {},
          sourceAuthProfiles: {},
          typesUrl: undefined,
          inventoryStatus: {
            state: "initializing",
            readyToolCount: 0,
            loadingSourceNames: [],
            sourceToolCounts: {},
          },
          nextCursor: null,
          totalTools: 0,
        };
      }

      return await listToolsWithWarnings({
        workspaceId: context.workspaceId,
        ...(context.accountId && { accountId: context.accountId }),
        ...(context.sessionId && { sessionId: context.sessionId }),
        includeDetails,
        fetchAll: true,
      });
    },
    enabled: !!context,
    placeholderData: (previousData) => previousData,
  });

  const inventoryData = inventoryQuery.data;
  const inventoryStatus = inventoryProgress?.inventoryStatus ?? inventoryData?.inventoryStatus;
  const tools = inventoryData?.tools ?? [];

  const loadToolDetails = useCallback(async (toolPaths: string[]): Promise<Record<string, ToolDetailDescriptor>> => {
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

      const detailsByPath = await listToolDetails({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        toolPaths: missing,
      });

      for (const tool of Object.values(detailsByPath)) {
        cache.set(tool.path, tool);
      }
    }

    const result: Record<string, ToolDetailDescriptor> = {};
    for (const path of requested) {
      const tool = cache.get(path);
      if (tool) {
        result[path] = tool;
      }
    }
    return result;
  }, [context, listToolDetails]);

  useEffect(() => {
    detailsCacheRef.current.clear();
  }, [context?.workspaceId, context?.accountId, context?.clientId, context?.sessionId]);

  useEffect(() => {
    if (!inventoryData || !includeDetails) {
      return;
    }
    const cache = detailsCacheRef.current;
    for (const tool of inventoryData.tools) {
      cache.set(tool.path, {
        path: tool.path,
        description: tool.description,
        ...(tool.display ? { display: tool.display } : {}),
        ...(tool.typing ? { typing: tool.typing } : {}),
      });
    }
  }, [inventoryData, includeDetails]);

  const loadMoreTools = useCallback(async () => {
    return;
  }, []);

  const loadMoreToolsForSource = useCallback(async () => {
    return;
  }, []);

  const rebuildInventoryNow = useCallback(async () => {
    if (!context) {
      return;
    }

    await listToolsWithWarnings({
      workspaceId: context.workspaceId,
      ...(context.accountId && { accountId: context.accountId }),
      ...(context.sessionId && { sessionId: context.sessionId }),
      includeDetails: false,
      includeSourceMeta: false,
      limit: 1,
      rebuildInventory: true,
    });
  }, [context, listToolsWithWarnings]);

  return {
    tools,
    warnings: inventoryData?.warnings ?? [],
    /** Workspace-wide Monaco `.d.ts` bundle URL (may be undefined). */
    typesUrl: inventoryData?.typesUrl,
    /** Per-source OpenAPI quality metrics (unknown/fallback type rates). */
    sourceQuality: inventoryData?.sourceQuality ?? {},
    sourceAuthProfiles: inventoryData?.sourceAuthProfiles ?? {},
    inventoryStatus,
    inventorySourceStates: inventoryProgress?.sourceStates ?? {},
    loadingSources: inventoryStatus?.loadingSourceNames ?? [],
    loadingTools: !!context && inventoryQuery.isLoading,
    refreshingTools: !!context && inventoryQuery.isFetching,
    loadingMoreTools: false,
    hasMoreTools: false,
    loadMoreTools,
    sourceHasMoreTools: {} as Record<string, boolean>,
    sourceLoadingMoreTools: {} as Record<string, boolean>,
    loadMoreToolsForSource,
    rebuildInventoryNow,
    totalTools: inventoryData?.totalTools ?? tools.length,
    loadedTools: tools.length,
    loadToolDetails,
  };
}
