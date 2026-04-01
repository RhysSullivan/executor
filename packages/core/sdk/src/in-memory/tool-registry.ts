import { Effect } from "effect";

import { ToolId } from "../ids";
import { ToolNotFoundError, ToolInvocationError } from "../errors";
import type { ToolRegistration, ToolInvoker, ToolListFilter, InvokeOptions } from "../tools";
import { reattachDefs } from "../schema-refs";

export const makeInMemoryToolRegistry = () => {
  const tools = new Map<string, ToolRegistration>();
  const invokers = new Map<string, ToolInvoker>();
  const sharedDefs = new Map<string, unknown>();

  return {
    list: (filter?: ToolListFilter) =>
      Effect.sync(() => {
        let result = [...tools.values()];
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
      Effect.fromNullable(tools.get(toolId)).pipe(
        Effect.mapError(() => new ToolNotFoundError({ toolId })),
        Effect.map((t) => ({
          id: t.id,
          inputSchema: reattachDefs(t.inputSchema, sharedDefs),
          outputSchema: reattachDefs(t.outputSchema, sharedDefs),
        })),
      ),

    definitions: () =>
      Effect.sync(() => {
        const result: Record<string, unknown> = {};
        for (const [k, v] of sharedDefs) {
          result[k] = v;
        }
        return result;
      }),

    registerDefinitions: (defs: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(defs)) {
          sharedDefs.set(k, v);
        }
      }),

    registerInvoker: (pluginKey: string, invoker: ToolInvoker) =>
      Effect.sync(() => {
        invokers.set(pluginKey, invoker);
      }),

    invoke: (toolId: ToolId, args: unknown, options?: InvokeOptions) =>
      Effect.gen(function* () {
        const tool = yield* Effect.fromNullable(tools.get(toolId)).pipe(
          Effect.mapError(() => new ToolNotFoundError({ toolId })),
        );
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
          tools.set(t.id, t);
        }
      }),

    unregister: (toolIds: readonly ToolId[]) =>
      Effect.sync(() => {
        for (const id of toolIds) {
          tools.delete(id);
        }
      }),

    unregisterBySource: (sourceId: string) =>
      Effect.sync(() => {
        for (const [id, t] of tools) {
          if (t.sourceId === sourceId) {
            tools.delete(id);
          }
        }
      }),
  };
};
