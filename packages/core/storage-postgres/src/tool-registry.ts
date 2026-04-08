// ---------------------------------------------------------------------------
// Postgres-backed ToolRegistry — relational tables instead of KV
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { eq, and } from "drizzle-orm";

import type { ToolId } from "@executor/core";
import type { DrizzleDb } from "./types";
import { ToolNotFoundError, ToolInvocationError, ToolRegistration } from "@executor/core";
import { buildToolTypeScriptPreview } from "@executor/core";
import type {
  ToolInvoker,
  ToolListFilter,
  InvokeOptions,
  RuntimeToolHandler,
} from "@executor/core";

import { tools, toolDefinitions } from "./schema";

export const makePgToolRegistry = (
  db: DrizzleDb,
  teamId: string,
) => {
  const runtimeTools = new Map<string, ToolRegistration>();
  const runtimeHandlers = new Map<string, RuntimeToolHandler>();
  const runtimeDefs = new Map<string, unknown>();
  const invokers = new Map<string, ToolInvoker>();

  const getPersistedTool = (id: string) =>
    Effect.tryPromise(async () => {
      const rows = await db
        .select()
        .from(tools)
        .where(and(eq(tools.id, id), eq(tools.teamId, teamId)));
      const row = rows[0];
      if (!row) return null;
      return new ToolRegistration({
        id: row.id as ToolId,
        pluginKey: row.pluginKey,
        sourceId: row.sourceId,
        name: row.name,
        description: row.description ?? undefined,
        mayElicit: row.mayElicit ?? undefined,
        inputSchema: row.inputSchema ?? undefined,
        outputSchema: row.outputSchema ?? undefined,
      });
    }).pipe(Effect.orDie);

  const getAllTools = () =>
    Effect.tryPromise(async () => {
      const rows = await db
        .select()
        .from(tools)
        .where(eq(tools.teamId, teamId));
      return rows.map(
        (row) =>
          new ToolRegistration({
            id: row.id as ToolId,
            pluginKey: row.pluginKey,
            sourceId: row.sourceId,
            name: row.name,
            description: row.description ?? undefined,
            mayElicit: row.mayElicit ?? undefined,
            inputSchema: row.inputSchema ?? undefined,
            outputSchema: row.outputSchema ?? undefined,
          }),
      );
    }).pipe(Effect.orDie);

  const getDefsMap = () =>
    Effect.tryPromise(async () => {
      const rows = await db
        .select()
        .from(toolDefinitions)
        .where(eq(toolDefinitions.teamId, teamId));
      const defs = new Map<string, unknown>(
        rows.map((r) => [r.name, r.schema]),
      );
      for (const [k, v] of runtimeDefs) defs.set(k, v);
      return defs;
    }).pipe(Effect.orDie);

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
      Effect.gen(function* () {
        const t = runtimeTools.get(toolId) ?? (yield* getPersistedTool(toolId));
        if (!t) return yield* new ToolNotFoundError({ toolId });
        const defs = yield* getDefsMap();
        const typeScriptPreview = buildToolTypeScriptPreview({
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          defs,
        });
        return { id: t.id, ...typeScriptPreview };
      }),

    definitions: () =>
      Effect.gen(function* () {
        const defs = yield* getDefsMap();
        return Object.fromEntries(defs);
      }),

    registerDefinitions: (newDefs: Record<string, unknown>) =>
      Effect.tryPromise(async () => {
        for (const [name, schema] of Object.entries(newDefs)) {
          await db
            .insert(toolDefinitions)
            .values({ name, teamId, schema })
            .onConflictDoUpdate({
              target: [toolDefinitions.name, toolDefinitions.teamId],
              set: { schema },
            });
        }
      }).pipe(Effect.orDie),

    registerRuntimeDefinitions: (newDefs: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [name, schema] of Object.entries(newDefs)) {
          runtimeDefs.set(name, schema);
        }
      }),

    unregisterRuntimeDefinitions: (names: readonly string[]) =>
      Effect.sync(() => {
        for (const name of names) runtimeDefs.delete(name);
      }),

    registerInvoker: (pluginKey: string, invoker: ToolInvoker) =>
      Effect.sync(() => { invokers.set(pluginKey, invoker); }),

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
      Effect.tryPromise(async () => {
        for (const t of newTools) {
          await db
            .insert(tools)
            .values({
              id: t.id,
              teamId,
              sourceId: t.sourceId,
              pluginKey: t.pluginKey,
              name: t.name,
              description: t.description,
              mayElicit: t.mayElicit,
              inputSchema: t.inputSchema,
              outputSchema: t.outputSchema,
            })
            .onConflictDoUpdate({
              target: [tools.id, tools.teamId],
              set: {
                sourceId: t.sourceId,
                pluginKey: t.pluginKey,
                name: t.name,
                description: t.description,
                mayElicit: t.mayElicit,
                inputSchema: t.inputSchema,
                outputSchema: t.outputSchema,
              },
            });
        }
      }).pipe(Effect.orDie),

    registerRuntime: (newTools: readonly ToolRegistration[]) =>
      Effect.sync(() => {
        for (const t of newTools) runtimeTools.set(t.id, t);
      }),

    registerRuntimeHandler: (toolId: ToolId, handler: RuntimeToolHandler) =>
      Effect.sync(() => { runtimeHandlers.set(toolId, handler); }),

    unregisterRuntime: (toolIds: readonly ToolId[]) =>
      Effect.sync(() => {
        for (const id of toolIds) {
          runtimeTools.delete(id);
          runtimeHandlers.delete(id);
        }
      }),

    unregister: (toolIds: readonly ToolId[]) =>
      Effect.tryPromise(async () => {
        for (const id of toolIds) {
          runtimeTools.delete(id);
          runtimeHandlers.delete(id);
          await db
            .delete(tools)
            .where(and(eq(tools.id, id), eq(tools.teamId, teamId)));
        }
      }).pipe(Effect.orDie),

    unregisterBySource: (sourceId: string) =>
      Effect.tryPromise(async () => {
        await db
          .delete(tools)
          .where(and(eq(tools.sourceId, sourceId), eq(tools.teamId, teamId)));
        for (const [id, t] of runtimeTools) {
          if (t.sourceId === sourceId) {
            runtimeTools.delete(id);
            runtimeHandlers.delete(id);
          }
        }
      }).pipe(Effect.orDie),
  };
};
