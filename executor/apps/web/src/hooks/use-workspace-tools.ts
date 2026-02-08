"use client";

import { useCallback, useEffect } from "react";
import { useQuery } from "convex/react";
import { convexApi } from "../lib/convex-api";
import * as api from "../lib/api";

interface WorkspaceContext {
  workspaceId: string;
  actorId?: string;
  clientId?: string;
}

export function useWorkspaceTools(context: WorkspaceContext | null) {
  const tools = useQuery(
    convexApi.database.listWorkspaceToolsForContext,
    context
      ? {
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          clientId: context.clientId,
        }
      : "skip",
  );

  const refresh = useCallback(async () => {
    if (!context) return;
    try {
      await api.listToolsForContext({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        clientId: context.clientId,
      });
    } catch {
      // best effort warm-up for server-side tool discovery sync
    }
  }, [context]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    tools,
    loading: !!context && tools === undefined,
    refresh,
  };
}
