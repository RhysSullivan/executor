// ---------------------------------------------------------------------------
// Storage-backed ToolRegistry
//
// Implements ToolRegistryService on top of a generic ExecutorStorage using
// the core `tools` and `toolDefinitions` models. Runtime-only state
// (runtime tools, runtime handlers, runtime definitions, invokers) stays
// in memory and is not persisted.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { ExecutorStorage } from "@executor/storage";

import type { Scope } from "../scope";
import { ToolId } from "../ids";
import { ToolNotFoundError, ToolInvocationError } from "../errors";
import {
  ToolRegistration,
  type ToolInvoker,
  type ToolListFilter,
  type InvokeOptions,
  type RuntimeToolHandler,
} from "../tools";
import { normalizeRefs, reattachDefs } from "../schema-refs";
import { buildToolTypeScriptPreview } from "../schema-types";

type ToolRow = {
  readonly id: string;
  readonly scopeId: string;
  readonly sourceId: string;
  readonly pluginKey: string;
  readonly name: string;
  readonly description?: string | null;
  readonly mayElicit?: boolean | null;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
};

type ToolDefinitionRow = {
  readonly name: string;
  readonly scopeId: string;
  readonly schema: unknown;
};

const rowToRegistration = (row: ToolRow): ToolRegistration =>
  new ToolRegistration({
    id: ToolId.make(row.id),
    pluginKey: row.pluginKey,
    sourceId: row.sourceId,
    name: row.name,
    description: row.description ?? undefined,
    mayElicit: row.mayElicit ?? undefined,
    inputSchema: row.inputSchema ?? undefined,
    outputSchema: row.outputSchema ?? undefined,
  });

export const makeStorageToolRegistry = (storage: ExecutorStorage, scope: Scope) => {
  const scopeId = scope.id as string;
  const runtimeTools = new Map<string, ToolRegistration>();
  const runtimeHandlers = new Map<string, RuntimeToolHandler>();
  const runtimeDefs = new Map<string, unknown>();
  const invokers = new Map<string, ToolInvoker>();

  const getPersistedTool = (toolId: ToolId) =>
    storage
      .findOne<ToolRow>({
        model: "tools",
        where: [
          { field: "id", value: toolId as string },
          { field: "scopeId", value: scopeId },
        ],
      })
      .pipe(
        Effect.map((row) => (row ? rowToRegistration(row) : null)),
        Effect.orDie,
      );

  const getAllTools = () =>
    storage
      .findMany<ToolRow>({
        model: "tools",
        where: [{ field: "scopeId", value: scopeId }],
      })
      .pipe(
        Effect.map((rows) => rows.map(rowToRegistration)),
        Effect.orDie,
      );

  const getDefsMap = () =>
    Effect.gen(function* () {
      const rows = yield* storage
        .findMany<ToolDefinitionRow>({
          model: "toolDefinitions",
          where: [{ field: "scopeId", value: scopeId }],
        })
        .pipe(Effect.orDie);
      const defs = new Map<string, unknown>(rows.map((row) => [row.name, row.schema]));
      for (const [k, v] of runtimeDefs) defs.set(k, v);
      return defs;
    });

  const upsertTool = (tool: ToolRegistration) =>
    Effect.gen(function* () {
      const update = {
        sourceId: tool.sourceId,
        pluginKey: tool.pluginKey,
        name: tool.name,
        description: tool.description ?? null,
        mayElicit: tool.mayElicit ?? false,
        inputSchema: normalizeRefs(tool.inputSchema) ?? null,
        outputSchema: normalizeRefs(tool.outputSchema) ?? null,
      };

      const updated = yield* storage
        .update<ToolRow>({
          model: "tools",
          where: [
            { field: "id", value: tool.id as string },
            { field: "scopeId", value: scopeId },
          ],
          update,
        })
        .pipe(Effect.orDie);

      if (updated) return;

      yield* storage
        .create<ToolRow>({
          model: "tools",
          data: {
            id: tool.id as string,
            scopeId,
            ...update,
          },
        })
        .pipe(Effect.orDie);
    });

  const upsertDefinition = (name: string, schema: unknown) =>
    Effect.gen(function* () {
      const updated = yield* storage
        .update<ToolDefinitionRow>({
          model: "toolDefinitions",
          where: [
            { field: "name", value: name },
            { field: "scopeId", value: scopeId },
          ],
          update: { schema: normalizeRefs(schema) },
        })
        .pipe(Effect.orDie);

      if (updated) return;

      yield* storage
        .create<ToolDefinitionRow>({
          model: "toolDefinitions",
          data: { name, scopeId, schema: normalizeRefs(schema) },
        })
        .pipe(Effect.orDie);
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
        for (const [name, schema] of Object.entries(newDefs)) {
          yield* upsertDefinition(name, schema);
        }
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
      Effect.gen(function* () {
        for (const tool of newTools) {
          yield* upsertTool(tool);
        }
      }),

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
        yield* storage
          .deleteMany({
            model: "tools",
            where: [
              { field: "id", operator: "in", value: toolIds as readonly string[] },
              { field: "scopeId", value: scopeId },
            ],
          })
          .pipe(Effect.orDie);
      }),

    unregisterBySource: (sourceId: string) =>
      Effect.gen(function* () {
        yield* storage
          .deleteMany({
            model: "tools",
            where: [
              { field: "sourceId", value: sourceId },
              { field: "scopeId", value: scopeId },
            ],
          })
          .pipe(Effect.orDie);
        for (const [id, tool] of runtimeTools) {
          if (tool.sourceId === sourceId) {
            runtimeTools.delete(id);
            runtimeHandlers.delete(id);
          }
        }
      }),
  };
};
