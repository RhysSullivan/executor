import type { ScopeId } from "@executor-js/sdk/shared";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { sourceCredentialBindingsAtom, sourcesOptimisticAtom } from "@executor-js/react/api/atoms";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { McpClient } from "./client";
import { McpSourceBindingRef } from "../sdk/types";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const mcpSourceAtom = (scopeId: ScopeId, namespace: string) =>
  McpClient.query("mcp", "getSource", {
    params: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

export const mcpSourceBindingsAtom = (
  scopeId: ScopeId,
  namespace: string,
  sourceScopeId: ScopeId,
) =>
  Atom.mapResult(sourceCredentialBindingsAtom(scopeId, namespace, sourceScopeId), (rows) =>
    rows.map((row) =>
      McpSourceBindingRef.make({
        sourceId: row.sourceId,
        sourceScopeId: row.sourceScopeId,
        scopeId: row.scopeId,
        slot: row.slotKey,
        value: row.value,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const probeMcpEndpoint = McpClient.mutation("mcp", "probeEndpoint");
export const addMcpSource = McpClient.mutation("mcp", "addSource");
export const addMcpSourceOptimistic = Atom.family((scopeId: ScopeId) =>
  sourcesOptimisticAtom(scopeId).pipe(
    Atom.optimisticFn({
      reducer: (current, arg) =>
        AsyncResult.map(current, (rows) => {
          const id = arg.payload.namespace ?? `pending-${Math.random().toString(36).slice(2)}`;
          const source = {
            id,
            scopeId,
            kind: "mcp",
            pluginId: "mcp",
            name: arg.payload.name ?? id,
            ...(arg.payload.transport === "remote" ? { url: arg.payload.endpoint } : {}),
            canRemove: false,
            canRefresh: false,
            canEdit: false,
            runtime: false,
          };
          return [source, ...rows.filter((row) => row.id !== id)].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        }),
      fn: addMcpSource,
    }),
  ),
);
export const removeMcpSource = McpClient.mutation("mcp", "removeSource");
export const refreshMcpSource = McpClient.mutation("mcp", "refreshSource");
