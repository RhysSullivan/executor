"use client";

import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { useQuery as useConvexQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import { executor } from "@/lib/executor-client";
import type { ToolDescriptor } from "@/lib/types";

interface WorkspaceContext {
  workspaceId: string;
  actorId?: string;
  clientId?: string;
}

/**
 * Fetches tool metadata from the server API (`GET /api/tools`) via Eden Treaty,
 * cached and deduplicated by TanStack Query.
 *
 * Automatically re-fetches when the Convex `toolSources` subscription changes
 * (the reactive value is included in the query key).
 */
export function useWorkspaceTools(context: WorkspaceContext | null) {
  // Watch tool sources reactively so we invalidate when sources change
  const toolSources = useConvexQuery(
    convexApi.database.listToolSources,
    context ? { workspaceId: context.workspaceId } : "skip",
  );

  const { data, isLoading } = useTanstackQuery({
    queryKey: [
      "workspace-tools",
      context?.workspaceId,
      context?.actorId,
      context?.clientId,
      toolSources,
    ],
    queryFn: async () => {
      if (!context) return [];
      const { data, error } = await executor.api.tools.get({
        query: {
          workspaceId: context.workspaceId,
          ...(context.actorId && { actorId: context.actorId }),
          ...(context.clientId && { clientId: context.clientId }),
        },
      });
      if (error) throw error;
      return data as ToolDescriptor[];
    },
    enabled: !!context,
  });

  return {
    tools: data ?? [],
    loading: !!context && isLoading,
  };
}
