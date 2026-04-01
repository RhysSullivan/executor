// ---------------------------------------------------------------------------
// KV-backed ToolRegistry
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import type { ToolId, ScopedKv } from "@executor/sdk";
import { ToolNotFoundError, ToolInvocationError, ToolRegistration } from "@executor/sdk";
import type { ToolInvoker, ToolListFilter, InvokeOptions } from "@executor/sdk";
import { reattachDefs } from "@executor/sdk";

// ---------------------------------------------------------------------------
// Serialization — leverage ToolRegistration Schema.Class directly
// ---------------------------------------------------------------------------

const ToolJson = Schema.parseJson(ToolRegistration);
const encodeTool = Schema.encodeSync(ToolJson);
const decodeTool = Schema.decodeUnknownSync(ToolJson);

// ---------------------------------------------------------------------------
// Factory — takes scoped KVs for tools and definitions
// ---------------------------------------------------------------------------

export const makeKvToolRegistry = (
  toolsKv: ScopedKv,
  defsKv: ScopedKv,
) => {
  const invokers = new Map<string, ToolInvoker>();

  const getTool = (id: string): Effect.Effect<ToolRegistration | null> =>
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
      return new Map(entries.map((e) => [e.key, JSON.parse(e.value)]));
    });

  return {
    list: (filter?: ToolListFilter) =>
      Effect.gen(function* () {
        let tools = yield* getAllTools();
        if (filter?.sourceId) {
          const sid = filter.sourceId;
          tools = tools.filter((t) => t.sourceId === sid);
        }
        if (filter?.query) {
          const q = filter.query.toLowerCase();
          tools = tools.filter(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              t.description?.toLowerCase().includes(q),
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
        const t = yield* getTool(toolId);
        if (!t) return yield* new ToolNotFoundError({ toolId });
        const defs = yield* getDefsMap();
        return {
          id: t.id,
          inputSchema: reattachDefs(t.inputSchema, defs),
          outputSchema: reattachDefs(t.outputSchema, defs),
        };
      }),

    definitions: () =>
      Effect.gen(function* () {
        const defs = yield* getDefsMap();
        return Object.fromEntries(defs);
      }),

    registerDefinitions: (newDefs: Record<string, unknown>) =>
      Effect.gen(function* () {
        for (const [name, schema] of Object.entries(newDefs)) {
          yield* defsKv.set(name, JSON.stringify(schema));
        }
      }),

    registerInvoker: (pluginKey: string, invoker: ToolInvoker) =>
      Effect.sync(() => { invokers.set(pluginKey, invoker); }),

    invoke: (toolId: ToolId, args: unknown, options?: InvokeOptions) =>
      Effect.gen(function* () {
        const tool = yield* getTool(toolId);
        if (!tool) return yield* new ToolNotFoundError({ toolId });
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
      Effect.gen(function* () {
        for (const t of newTools) {
          yield* toolsKv.set(t.id, encodeTool(t));
        }
      }),

    unregister: (toolIds: readonly ToolId[]) =>
      Effect.gen(function* () {
        for (const id of toolIds) {
          yield* toolsKv.delete(id);
        }
      }),

    unregisterBySource: (sourceId: string) =>
      Effect.gen(function* () {
        const allTools = yield* getAllTools();
        for (const t of allTools) {
          if (t.sourceId === sourceId) {
            yield* toolsKv.delete(t.id);
          }
        }
      }),
  };
};
