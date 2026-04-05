import { Effect } from "effect";

import { ToolId } from "../ids";
import { ToolNotFoundError, ToolInvocationError } from "../errors";
import type {
  ToolRegistration,
  ToolInvoker,
  ToolListFilter,
  InvokeOptions,
  RuntimeToolHandler,
} from "../tools";
import { normalizeRefs } from "../schema-refs";
import { buildToolTypeScriptPreview } from "../schema-types";

export const makeInMemoryToolRegistry = () => {
  const tools = new Map<string, ToolRegistration>();
  const runtimeTools = new Map<string, ToolRegistration>();
  const runtimeHandlers = new Map<string, RuntimeToolHandler>();
  const invokers = new Map<string, ToolInvoker>();
  const sharedDefs = new Map<string, unknown>();
  const runtimeDefs = new Map<string, unknown>();

  const getTool = (toolId: ToolId): ToolRegistration | undefined =>
    runtimeTools.get(toolId) ?? tools.get(toolId);

  const getDefs = (): Map<string, unknown> => {
    const defs = new Map<string, unknown>();
    for (const [k, v] of sharedDefs) defs.set(k, v);
    for (const [k, v] of runtimeDefs) defs.set(k, v);
    return defs;
  };

  return {
    list: (filter?: ToolListFilter) =>
      Effect.sync(() => {
        const byId = new Map<string, ToolRegistration>();
        for (const tool of tools.values()) byId.set(tool.id, tool);
        for (const tool of runtimeTools.values()) byId.set(tool.id, tool);

        let result = [...byId.values()];
        if (filter?.sourceId) {
          const sid = filter.sourceId;
          result = result.filter((t) => t.sourceId === sid);
        }
        if (filter?.query) {
          const q = filter.query.toLowerCase();
          result = result.filter(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              t.description?.toLowerCase().includes(q),
          );
        }
        return result.map((t) => ({
          id: t.id,
          pluginKey: t.pluginKey,
          sourceId: t.sourceId,
          name: t.name,
          description: t.description,
        }));
      }),

    schema: (toolId: ToolId) =>
      Effect.fromNullable(getTool(toolId)).pipe(
        Effect.mapError(() => new ToolNotFoundError({ toolId })),
        Effect.map((t) => {
          const defs = getDefs();
          const typeScriptPreview = buildToolTypeScriptPreview({
            inputSchema: t.inputSchema,
            outputSchema: t.outputSchema,
            defs,
          });

          return {
            id: t.id,
            ...typeScriptPreview,
          };
        }),
      ),

    definitions: () =>
      Effect.sync(() => {
        const result: Record<string, unknown> = {};
        for (const [k, v] of sharedDefs) {
          result[k] = v;
        }
        for (const [k, v] of runtimeDefs) {
          result[k] = v;
        }
        return result;
      }),

    registerDefinitions: (defs: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(defs)) {
          sharedDefs.set(k, normalizeRefs(v));
        }
      }),

    registerRuntimeDefinitions: (defs: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(defs)) {
          runtimeDefs.set(k, normalizeRefs(v));
        }
      }),

    unregisterRuntimeDefinitions: (names: readonly string[]) =>
      Effect.sync(() => {
        for (const name of names) {
          runtimeDefs.delete(name);
        }
      }),

    registerInvoker: (pluginKey: string, invoker: ToolInvoker) =>
      Effect.sync(() => {
        invokers.set(pluginKey, invoker);
      }),

    resolveAnnotations: (toolId: ToolId) =>
      Effect.gen(function* () {
        const tool = getTool(toolId);
        if (!tool) return undefined;
        const runtimeHandler = runtimeHandlers.get(toolId);
        if (runtimeHandler?.resolveAnnotations) {
          return yield* runtimeHandler.resolveAnnotations();
        }
        const invoker = invokers.get(tool.pluginKey);
        if (!invoker?.resolveAnnotations) return undefined;
        return yield* invoker.resolveAnnotations(toolId);
      }),

    invoke: (toolId: ToolId, args: unknown, options: InvokeOptions) =>
      Effect.gen(function* () {
        const tool = yield* Effect.fromNullable(getTool(toolId)).pipe(
          Effect.mapError(() => new ToolNotFoundError({ toolId })),
        );
        const runtimeHandler = runtimeHandlers.get(toolId);
        if (runtimeHandler) {
          return yield* runtimeHandler.invoke(args, options);
        }
        const invoker = invokers.get(tool.pluginKey);
        if (!invoker) {
          return yield* new ToolInvocationError({
            toolId,
            message: `No invoker registered for plugin "${tool.pluginKey}"`,
            cause: undefined,
          });
        }
        return yield* invoker.invoke(toolId, args, options);
      }),

    register: (newTools: readonly ToolRegistration[]) =>
      Effect.sync(() => {
        for (const t of newTools) {
          tools.set(t.id, {
            ...t,
            inputSchema: normalizeRefs(t.inputSchema),
            outputSchema: normalizeRefs(t.outputSchema),
          });
        }
      }),

    registerRuntime: (newTools: readonly ToolRegistration[]) =>
      Effect.sync(() => {
        for (const t of newTools) {
          runtimeTools.set(t.id, {
            ...t,
            inputSchema: normalizeRefs(t.inputSchema),
            outputSchema: normalizeRefs(t.outputSchema),
          });
        }
      }),

    registerRuntimeHandler: (toolId: ToolId, handler: RuntimeToolHandler) =>
      Effect.sync(() => {
        runtimeHandlers.set(toolId, handler);
      }),

    unregisterRuntime: (toolIds: readonly ToolId[]) =>
      Effect.sync(() => {
        for (const id of toolIds) {
          runtimeTools.delete(id);
          runtimeHandlers.delete(id);
        }
      }),

    unregister: (toolIds: readonly ToolId[]) =>
      Effect.sync(() => {
        for (const id of toolIds) {
          tools.delete(id);
          runtimeTools.delete(id);
          runtimeHandlers.delete(id);
        }
      }),

    unregisterBySource: (sourceId: string) =>
      Effect.sync(() => {
        for (const [id, t] of tools) {
          if (t.sourceId === sourceId) {
            tools.delete(id);
          }
        }
        for (const [id, t] of runtimeTools) {
          if (t.sourceId === sourceId) {
            runtimeTools.delete(id);
            runtimeHandlers.delete(id);
          }
        }
      }),
  };
};
