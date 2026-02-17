"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useAction, useQuery as useConvexQuery } from "convex/react";
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

type ListToolsWithWarningsAction = (args: {
  workspaceId: Id<"workspaces">;
  accountId?: string;
  clientId?: string;
  sessionId?: string;
  includeDetails?: boolean;
  includeSourceMeta?: boolean;
  toolPaths?: string[];
  source?: string;
  sourceName?: string;
  cursor?: string;
  limit?: number;
  buildId?: string;
}) => Promise<WorkspaceToolsQueryResult>;

interface ToolInventoryPageParam {
  cursor?: string;
  buildId?: string;
}

interface SourceToolPageState {
  tools: ToolDescriptor[];
  nextCursor?: string | null;
  buildId?: string;
  loading: boolean;
}

const DEFAULT_PAGE_SIZE = 250;

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
  const listToolsWithWarnings = listToolsWithWarningsRaw as ListToolsWithWarningsAction;
  const detailsCacheRef = useRef<Map<string, ToolDescriptor>>(new Map());
  const [sourcePages, setSourcePages] = useState<Record<string, SourceToolPageState>>({});

  // Watch tool sources reactively so we invalidate when sources change
  const toolSources = useConvexQuery(
    convexApi.workspace.listToolSources,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
  );

  const inventoryQuery = useInfiniteQuery<WorkspaceToolsQueryResult, Error, InfiniteData<WorkspaceToolsQueryResult>, unknown[], ToolInventoryPageParam>({
    queryKey: [
      "workspace-tools-inventory",
      context?.workspaceId,
      context?.accountId,
      context?.clientId,
      includeDetails,
      toolSources,
    ],
    queryFn: async ({ pageParam }): Promise<WorkspaceToolsQueryResult> => {
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
        ...(context.clientId && { clientId: context.clientId }),
        ...(context.sessionId && { sessionId: context.sessionId }),
        includeDetails,
        limit: DEFAULT_PAGE_SIZE,
        ...(pageParam?.cursor ? { cursor: pageParam.cursor } : {}),
        ...(pageParam?.buildId ? { buildId: pageParam.buildId } : {}),
      });
    },
    initialPageParam: {},
    getNextPageParam: (lastPage) => {
      const nextCursor = lastPage.nextCursor;
      if (!nextCursor) {
        return undefined;
      }
      return {
        cursor: nextCursor,
        buildId: lastPage.inventoryStatus.readyBuildId,
      };
    },
    enabled: !!context,
    refetchInterval: (query) => {
      const data = query.state.data as InfiniteData<WorkspaceToolsQueryResult> | undefined;
      const first = data?.pages[0];
      const state = first?.inventoryStatus.state;
      if (state === "initializing" || state === "rebuilding") {
        return 2_000;
      }
      return false;
    },
    placeholderData: (previousData) => previousData,
  });

  const pages = inventoryQuery.data?.pages ?? [];
  const inventoryData = pages[0];
  const tools = useMemo(() => {
    const merged = new Map<string, ToolDescriptor>();
    for (const page of pages) {
      for (const tool of page.tools) {
        merged.set(tool.path, tool);
      }
    }
    for (const sourcePage of Object.values(sourcePages)) {
      for (const tool of sourcePage.tools) {
        merged.set(tool.path, tool);
      }
    }
    return [...merged.values()];
  }, [pages, sourcePages]);

  const loadMoreToolsForSource = useCallback(async (
    source: { source: string; sourceName: string },
  ): Promise<void> => {
    if (!context) {
      return;
    }

    const current = sourcePages[source.sourceName];
    if (current?.loading || current?.nextCursor === null) {
      return;
    }

    setSourcePages((prev) => ({
      ...prev,
      [source.sourceName]: {
        tools: prev[source.sourceName]?.tools ?? [],
        nextCursor: prev[source.sourceName]?.nextCursor,
        buildId: prev[source.sourceName]?.buildId,
        loading: true,
      },
    }));

    try {
      const response = await listToolsWithWarnings({
        workspaceId: context.workspaceId,
        ...(context.accountId && { accountId: context.accountId }),
        ...(context.clientId && { clientId: context.clientId }),
        ...(context.sessionId && { sessionId: context.sessionId }),
        includeDetails,
        source: source.source,
        sourceName: source.sourceName,
        limit: DEFAULT_PAGE_SIZE,
        ...(current?.nextCursor ? { cursor: current.nextCursor } : {}),
        ...(current?.buildId ? { buildId: current.buildId } : {}),
      });

      setSourcePages((prev) => {
        const existingTools = prev[source.sourceName]?.tools ?? [];
        const merged = new Map<string, ToolDescriptor>();
        for (const tool of existingTools) {
          merged.set(tool.path, tool);
        }
        for (const tool of response.tools) {
          merged.set(tool.path, tool);
        }
        return {
          ...prev,
          [source.sourceName]: {
            tools: [...merged.values()],
            nextCursor: response.nextCursor ?? null,
            buildId: response.inventoryStatus.readyBuildId,
            loading: false,
          },
        };
      });
    } catch {
      setSourcePages((prev) => ({
        ...prev,
        [source.sourceName]: {
          tools: prev[source.sourceName]?.tools ?? [],
          nextCursor: prev[source.sourceName]?.nextCursor ?? null,
          buildId: prev[source.sourceName]?.buildId,
          loading: false,
        },
      }));
    }
  }, [context, includeDetails, listToolsWithWarnings, sourcePages]);

  const sourceLoadingMoreTools = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const [sourceName, state] of Object.entries(sourcePages)) {
      result[sourceName] = state.loading;
    }
    return result;
  }, [sourcePages]);

  const sourceHasMoreTools = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const [sourceName, state] of Object.entries(sourcePages)) {
      result[sourceName] = state.nextCursor !== null;
    }
    return result;
  }, [sourcePages]);

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
        ...(context.accountId && { accountId: context.accountId }),
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
  }, [context?.workspaceId, context?.accountId, context?.clientId, context?.sessionId]);

  useEffect(() => {
    setSourcePages({});
  }, [
    context?.workspaceId,
    context?.accountId,
    context?.clientId,
    context?.sessionId,
    inventoryData?.inventoryStatus.readyBuildId,
  ]);

  useEffect(() => {
    if (!inventoryData || !includeDetails) {
      return;
    }
    const cache = detailsCacheRef.current;
    for (const tool of inventoryData.tools) {
      cache.set(tool.path, tool);
    }
  }, [inventoryData, includeDetails]);

  const loadMoreTools = useCallback(async () => {
    if (!inventoryQuery.hasNextPage || inventoryQuery.isFetchingNextPage) {
      return;
    }
    await inventoryQuery.fetchNextPage();
  }, [inventoryQuery]);

  return {
    tools,
    warnings: inventoryData?.warnings ?? [],
    /** Workspace-wide Monaco `.d.ts` bundle URL (may be undefined). */
    typesUrl: inventoryData?.typesUrl,
    /** Per-source OpenAPI quality metrics (unknown/fallback type rates). */
    sourceQuality: inventoryData?.sourceQuality ?? {},
    sourceAuthProfiles: inventoryData?.sourceAuthProfiles ?? {},
    inventoryStatus: inventoryData?.inventoryStatus,
    loadingSources: inventoryData?.inventoryStatus.loadingSourceNames ?? [],
    loadingTools: !!context && inventoryQuery.isLoading,
    refreshingTools: !!context && inventoryQuery.isFetching,
    loadingMoreTools: inventoryQuery.isFetchingNextPage,
    hasMoreTools: Boolean(inventoryQuery.hasNextPage),
    loadMoreTools,
    sourceHasMoreTools,
    sourceLoadingMoreTools,
    loadMoreToolsForSource,
    totalTools: inventoryData?.totalTools ?? tools.length,
    loadedTools: tools.length,
    loadToolDetails,
  };
}
