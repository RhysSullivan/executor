// ---------------------------------------------------------------------------
// KV-backed ToolRegistry
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import type { ToolId, ScopedKv } from "@executor/sdk";
import { ToolNotFoundError, ToolInvocationError, ToolRegistration } from "@executor/sdk";
import type { ToolInvoker, ToolListFilter, InvokeOptions, RuntimeToolHandler } from "@executor/sdk";
import { buildToolTypeScriptPreview, reattachDefs } from "@executor/sdk";

// ---------------------------------------------------------------------------
// Serialization — leverage ToolRegistration Schema.Class directly
// ---------------------------------------------------------------------------

const ToolJson = Schema.parseJson(ToolRegistration);
const encodeTool = Schema.encodeSync(ToolJson);
const decodeTool = Schema.decodeUnknownSync(ToolJson);

// ---------------------------------------------------------------------------
// Factory — takes scoped KVs for tools and definitions
// ---------------------------------------------------------------------------

export const makeKvToolRegistry = (toolsKv: ScopedKv, defsKv: ScopedKv) => {
  const withKvTransaction = <A, E>(
    kv: ScopedKv,
    effect: Effect.Effect<A, E, never>,
  ): Effect.Effect<A, E, never> => kv.withTransaction?.(effect) ?? effect;

  const runtimeTools = new Map<string, ToolRegistration>();
  const runtimeHandlers = new Map<string, RuntimeToolHandler>();
  const runtimeDefs = new Map<string, unknown>();
  const invokers = new Map<string, ToolInvoker>();

  const getPersistedTool = (id: string): Effect.Effect<ToolRegistration | null> =>
    Effect.gen(function* () {
      const raw = yield* toolsKv.get(id);
      if (!raw) return null;
      return decodeTool(raw);
    });

  const getAllTools = (): Effect.Effect<ToolRegistration[]> =>
    Effect.gen(function* () {
      const entries = yield* toolsKv.list();
      return entries.map((e) => decodeTool(e.value));
    });

  const getDefsMap = (): Effect.Effect<Map<string, unknown>> =>
    Effect.gen(function* () {
      const entries = yield* defsKv.list();
      const defs = yield* Effect.try(
        () => new Map(entries.map((e) => [e.key, JSON.parse(e.value)])),
      ).pipe(Effect.orDie);
      for (const [k, v] of runtimeDefs) defs.set(k, v);
      return defs;
    });

  return {
    list: (filter?: ToolListFilter) =>
      Effect.gen(function* () {
        const byId = new Map<string, ToolRegistration>();
        for (const tool of yield* getAllTools()) byId.set(tool.id, tool);
        for (const tool of runtimeTools.values()) byId.set(tool.id, tool);

        let tools = [...byId.values()];
        if (filter?.sourceId) {
          const sid = filter.sourceId;
          tools = tools.filter((t) => t.sourceId === sid);
        }
        if (filter?.query) {
          const q = filter.query.toLowerCase();
          tools = tools.filter(
            (t) => t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
          );
        }
        return tools.map((t) => ({
          id: t.id,
          pluginKey: t.pluginKey,
          sourceId: t.sourceId,
          name: t.name,
          description: t.description,
        }));
      }),

    schema: (toolId: ToolId) =>
      Effect.gen(function* () {
        const t = runtimeTools.get(toolId) ?? (yield* getPersistedTool(toolId));
        if (!t) return yield* new ToolNotFoundError({ toolId });
        const defs = yield* getDefsMap();
        const typeScriptPreview = buildToolTypeScriptPreview({
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          defs,
          options: {
            maxLength: Infinity,
            maxProperties: Infinity,
            maxCompositeMembers: Infinity,
            maxRefDepth: 20,
          },
        });

        return {
          id: t.id,
          ...typeScriptPreview,
          inputSchema: t.inputSchema ? reattachDefs(t.inputSchema, defs) : undefined,
          outputSchema: t.outputSchema ? reattachDefs(t.outputSchema, defs) : undefined,
        };
      }),

    definitions: () =>
      Effect.gen(function* () {
        const defs = yield* getDefsMap();
        return Object.fromEntries(defs);
      }),

    registerDefinitions: (newDefs: Record<string, unknown>) =>
      withKvTransaction(
        defsKv,
        defsKv.set(
          Object.entries(newDefs).map(([name, schema]) => ({
            key: name,
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            value: JSON.stringify(schema),
          })),
        ),
      ),

    registerRuntimeDefinitions: (newDefs: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [name, schema] of Object.entries(newDefs)) {
          runtimeDefs.set(name, schema);
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
      withKvTransaction(
        toolsKv,
        toolsKv.set(newTools.map((t) => ({ key: t.id, value: encodeTool(t) }))),
      ),

    registerRuntime: (newTools: readonly ToolRegistration[]) =>
      Effect.sync(() => {
        for (const t of newTools) {
          runtimeTools.set(t.id, t);
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
        yield* toolsKv.delete([...toolIds]);
      }),

    unregisterBySource: (sourceId: string) =>
      Effect.gen(function* () {
        const allTools = yield* getAllTools();
        const idsToDelete = allTools.filter((t) => t.sourceId === sourceId).map((t) => t.id);
        if (idsToDelete.length > 0) yield* toolsKv.delete(idsToDelete);
        for (const [id, t] of runtimeTools) {
          if (t.sourceId === sourceId) {
            runtimeTools.delete(id);
            runtimeHandlers.delete(id);
          }
        }
      }),
  };
};
