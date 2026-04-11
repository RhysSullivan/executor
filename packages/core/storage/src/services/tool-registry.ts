// ---------------------------------------------------------------------------
// makeToolRegistry — service factory for the ToolRegistry Context.Tag.
//
// Ports business logic from storage-stores/tool-registry.ts, replacing
// ExecutorStorage CRUD calls with typed ToolStore methods.
// Runtime-only state (runtime tools, handlers, invokers, definitions) stays
// in memory and is never persisted.
// ---------------------------------------------------------------------------

import { Effect, type Context } from "effect";

import type { Scope } from "../scope";
import { ToolId } from "../ids";
import { ToolNotFoundError, ToolInvocationError } from "../errors";
import type {
  ToolInvoker,
  ToolListFilter,
  InvokeOptions,
  RuntimeToolHandler,
  ToolRegistration,
} from "../tools";
import { normalizeRefs, reattachDefs } from "../schema-refs";
import { buildToolTypeScriptPreview } from "../schema-types";
import type { ToolRegistry } from "../tools";
import type { ToolStore } from "../stores/tool-store";

export const makeToolRegistry = (
  store: ToolStore,
  scope: Scope,
): Context.Tag.Service<typeof ToolRegistry> => {
  const scopeId = scope.id;
  const runtimeTools = new Map<string, ToolRegistration>();
  const runtimeHandlers = new Map<string, RuntimeToolHandler>();
  const runtimeDefs = new Map<string, unknown>();
  const invokers = new Map<string, ToolInvoker>();

  const getPersistedTool = (toolId: ToolId) =>
    store.findById(toolId, scopeId);

  const getAllTools = () => store.findByScope(scopeId);

  const getDefsMap = () =>
    Effect.gen(function* () {
      const persisted = yield* store.findDefinitions(scopeId);
      const defs = new Map<string, unknown>(Object.entries(persisted));
      for (const [k, v] of runtimeDefs) defs.set(k, v);
      return defs;
    });

  return {
    list: (filter?: ToolListFilter) =>
      Effect.gen(function* () {
        const byId = new Map<string, ToolRegistration>();
        for (const tool of yield* getAllTools()) byId.set(tool.id, tool);
        for (const tool of runtimeTools.values()) byId.set(tool.id, tool);

        let result = [...byId.values()];
        if (filter?.sourceId) {
          const sid = filter.sourceId;
          result = result.filter((t) => t.sourceId === sid);
        }
        if (filter?.query) {
          const q = filter.query.toLowerCase();
          result = result.filter(
            (t) => t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
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
      Effect.gen(function* () {
        const tool = runtimeTools.get(toolId) ?? (yield* getPersistedTool(toolId));
        if (!tool) return yield* new ToolNotFoundError({ toolId });
        const defs = yield* getDefsMap();
        const typeScriptPreview = buildToolTypeScriptPreview({
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          defs,
        });
        return {
          id: tool.id,
          ...typeScriptPreview,
          inputSchema: tool.inputSchema ? reattachDefs(tool.inputSchema, defs) : undefined,
          outputSchema: tool.outputSchema ? reattachDefs(tool.outputSchema, defs) : undefined,
        };
      }),

    definitions: () =>
      Effect.gen(function* () {
        const defs = yield* getDefsMap();
        return Object.fromEntries(defs);
      }),

    registerDefinitions: (newDefs: Record<string, unknown>) =>
      Effect.gen(function* () {
        const normalized: Record<string, unknown> = {};
        for (const [name, schema] of Object.entries(newDefs)) {
          normalized[name] = normalizeRefs(schema);
        }
        yield* store.upsertDefinitions(normalized, scopeId);
      }),

    registerRuntimeDefinitions: (newDefs: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [name, schema] of Object.entries(newDefs)) {
          runtimeDefs.set(name, normalizeRefs(schema));
        }
      }),

    unregisterRuntimeDefinitions: (names: readonly string[]) =>
      Effect.sync(() => {
        for (const name of names) runtimeDefs.delete(name);
      }),

    registerInvoker: (pluginKey: string, invoker: ToolInvoker) =>
      Effect.sync(() => {
        invokers.set(pluginKey, invoker);
      }),

    resolveAnnotations: (toolId: ToolId) =>
      Effect.gen(function* () {
        const tool = runtimeTools.get(toolId) ?? (yield* getPersistedTool(toolId));
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
        const tool = runtimeTools.get(toolId) ?? (yield* getPersistedTool(toolId));
        if (!tool) return yield* new ToolNotFoundError({ toolId });
        const runtimeHandler = runtimeHandlers.get(toolId);
        if (runtimeHandler) return yield* runtimeHandler.invoke(args, options);
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
      store.upsert(newTools, scopeId),

    registerRuntime: (newTools: readonly ToolRegistration[]) =>
      Effect.sync(() => {
        for (const tool of newTools) {
          runtimeTools.set(tool.id, {
            ...tool,
            inputSchema: normalizeRefs(tool.inputSchema),
            outputSchema: normalizeRefs(tool.outputSchema),
          } as ToolRegistration);
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
      Effect.gen(function* () {
        for (const id of toolIds) {
          runtimeTools.delete(id);
          runtimeHandlers.delete(id);
        }
        if (toolIds.length === 0) return;
        yield* store.deleteByIds(toolIds, scopeId);
      }),

    unregisterBySource: (sourceId: string) =>
      Effect.gen(function* () {
        yield* store.deleteBySource(sourceId, scopeId);
        for (const [id, tool] of runtimeTools) {
          if (tool.sourceId === sourceId) {
            runtimeTools.delete(id);
            runtimeHandlers.delete(id);
          }
        }
      }),
  };
};

