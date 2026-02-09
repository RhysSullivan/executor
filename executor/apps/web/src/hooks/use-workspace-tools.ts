"use client";

import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { useAction, useQuery as useConvexQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";

interface WorkspaceContext {
  workspaceId: string;
  actorId?: string;
  clientId?: string;
  sessionId?: string;
}

/**
 * Fetches tool metadata from a Convex action, cached by TanStack Query.
 *
 * Automatically re-fetches when the Convex `toolSources` subscription changes
 * (the reactive value is included in the query key).
 */
export function useWorkspaceTools(context: WorkspaceContext | null) {
  const listToolsWithWarnings = useAction(convexApi.executorNode.listToolsWithWarnings);

  // Watch tool sources reactively so we invalidate when sources change
  const toolSources = useConvexQuery(
    convexApi.workspace.listToolSources,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
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
      if (!context) return { tools: [], warnings: [], dtsUrls: {} };
      return await listToolsWithWarnings({
        workspaceId: context.workspaceId,
        ...(context.actorId && { actorId: context.actorId }),
        ...(context.clientId && { clientId: context.clientId }),
        ...(context.sessionId && { sessionId: context.sessionId }),
      });
    },
    enabled: !!context,
  });

  return {
    tools: data?.tools ?? [],
    warnings: data?.warnings ?? [],
    /** Per-source .d.ts download URLs for Monaco IntelliSense. Keyed by source key (e.g. "openapi:cloudflare"). */
    dtsUrls: (data as any)?.dtsUrls ?? {},
    loading: !!context && isLoading,
  };
}
