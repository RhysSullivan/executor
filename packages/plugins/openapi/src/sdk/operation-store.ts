import { Effect } from "effect";
import type { ToolId } from "@executor/sdk";

import type { OperationBinding, InvocationConfig } from "./types";

// ---------------------------------------------------------------------------
// Operation store — plugin's own storage for invocation data
// ---------------------------------------------------------------------------

export interface OpenApiOperationStore {
  readonly get: (
    toolId: ToolId,
  ) => Effect.Effect<{ binding: OperationBinding; config: InvocationConfig } | null>;

  readonly put: (
    toolId: ToolId,
    namespace: string,
    binding: OperationBinding,
    config: InvocationConfig,
  ) => Effect.Effect<void>;

  readonly remove: (toolId: ToolId) => Effect.Effect<void>;

  /** List all tool IDs for a given namespace */
  readonly listByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  /** Remove all entries for a namespace */
  readonly removeByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export const makeInMemoryOperationStore = (): OpenApiOperationStore => {
  const store = new Map<
    string,
    { binding: OperationBinding; config: InvocationConfig; namespace: string }
  >();

  return {
    get: (toolId) =>
      Effect.sync(() => {
        const entry = store.get(toolId);
        return entry ? { binding: entry.binding, config: entry.config } : null;
      }),

    put: (toolId, namespace, binding, config) =>
      Effect.sync(() => {
        store.set(toolId, { binding, config, namespace });
      }),

    remove: (toolId) =>
      Effect.sync(() => {
        store.delete(toolId);
      }),

    listByNamespace: (namespace) =>
      Effect.sync(() =>
        [...store.entries()]
          .filter(([, v]) => v.namespace === namespace)
          .map(([k]) => k as ToolId),
      ),

    removeByNamespace: (namespace) =>
      Effect.sync(() => {
        const ids: ToolId[] = [];
        for (const [k, v] of store) {
          if (v.namespace === namespace) {
            ids.push(k as ToolId);
            store.delete(k);
          }
        }
        return ids;
      }),

  };
};
