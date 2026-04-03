import { Effect, JSONSchema, Schema } from "effect";

import { ToolId } from "./ids";
import { ToolInvocationError } from "./errors";
import { Source } from "./sources";
import {
  ToolInvocationResult,
  type ToolRegistration,
  type RuntimeToolHandler,
} from "./tools";
import { hoistDefinitions } from "./schema-refs";

export interface RuntimeToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly sourceId?: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Schema.Schema<TInput, any, never>;
  readonly outputSchema?: Schema.Schema<TOutput, any, never>;
  readonly handler: (args: TInput) => Effect.Effect<unknown, unknown>;
}

export interface RuntimeSourceDefinition {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
}

interface RuntimeHandlerEntry {
  readonly decode: (args: unknown) => unknown;
  readonly handler: (args: unknown) => Effect.Effect<unknown, unknown>;
}

export const runtimeTool = <TInput, TOutput>(
  def: RuntimeToolDefinition<TInput, TOutput>,
): RuntimeToolDefinition<TInput, TOutput> => def;

const buildRuntimeTool = (
  pluginKey: string,
  sourceId: string,
  def: RuntimeToolDefinition,
): {
  readonly registration: ToolRegistration;
  readonly definitions: Record<string, unknown>;
  readonly entry: RuntimeHandlerEntry;
} => {
  const inputJson = JSONSchema.make(def.inputSchema);
  const outputJson = def.outputSchema ? JSONSchema.make(def.outputSchema) : undefined;

  const inputHoist = hoistDefinitions(inputJson);
  const outputHoist = hoistDefinitions(outputJson);

  return {
    registration: {
      id: ToolId.make(def.id),
      pluginKey,
      sourceId,
      name: def.name,
      description: def.description,
      inputSchema: inputHoist.stripped,
      outputSchema: outputHoist.stripped,
    },
    definitions: {
      ...inputHoist.defs,
      ...outputHoist.defs,
    },
    entry: {
      decode: Schema.decodeUnknownSync(def.inputSchema),
      handler: def.handler as (args: unknown) => Effect.Effect<unknown, unknown>,
    },
  };
};

const toRuntimeHandler = (
  toolId: ToolId,
  entry: RuntimeHandlerEntry,
): RuntimeToolHandler => ({
  invoke: (args) =>
    Effect.try({
      try: () => entry.decode(args),
      catch: (err) =>
        new ToolInvocationError({
          toolId,
          message: `Invalid input: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        }),
    }).pipe(
      Effect.flatMap((input) => entry.handler(input)),
      Effect.map((data) => new ToolInvocationResult({ data, error: null })),
      Effect.mapError((err) =>
        err instanceof ToolInvocationError
          ? err
          : new ToolInvocationError({
              toolId,
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
      ),
    ),
});

export const registerRuntimeTools = <
  const TTools extends readonly RuntimeToolDefinition<any, any>[],
>(input: {
  readonly registry: {
    readonly registerRuntimeDefinitions: (
      defs: Record<string, unknown>,
    ) => Effect.Effect<void>;
    readonly unregisterRuntimeDefinitions: (
      names: readonly string[],
    ) => Effect.Effect<void>;
    readonly registerRuntime: (
      tools: readonly ToolRegistration[],
    ) => Effect.Effect<void>;
    readonly registerRuntimeHandler: (
      toolId: ToolId,
      handler: RuntimeToolHandler,
    ) => Effect.Effect<void>;
    readonly unregisterRuntime: (
      toolIds: readonly ToolId[],
    ) => Effect.Effect<void>;
  };
  readonly sources?: {
    readonly registerRuntime: (source: Source) => Effect.Effect<void>;
    readonly unregisterRuntime: (sourceId: string) => Effect.Effect<void>;
  };
  readonly pluginKey: string;
  readonly source?: RuntimeSourceDefinition;
  readonly tools: TTools;
}) =>
  Effect.gen(function* () {
    const built = yield* Effect.forEach(input.tools, (tool) =>
      Effect.sync(() => {
        const sourceId = tool.sourceId ?? input.source?.id;
        if (!sourceId) {
          throw new Error(
            `Runtime tool "${tool.id}" is missing a sourceId and no shared runtime source was provided`,
          );
        }
        return buildRuntimeTool(input.pluginKey, sourceId, tool);
      }),
    );

    if (input.source && input.sources) {
      yield* input.sources.registerRuntime(new Source({
        id: input.source.id,
        name: input.source.name,
        kind: input.source.kind ?? input.pluginKey,
        runtime: true,
        canRemove: input.source.canRemove ?? false,
        canRefresh: input.source.canRefresh ?? false,
      }));
    }

    const defs: Record<string, unknown> = {};
    for (const tool of built) {
      Object.assign(defs, tool.definitions);
      yield* input.registry.registerRuntimeHandler(
        tool.registration.id,
        toRuntimeHandler(tool.registration.id, tool.entry),
      );
    }

    yield* input.registry.registerRuntimeDefinitions(defs);
    yield* input.registry.registerRuntime(built.map((tool) => tool.registration));

    const toolIds = built.map((tool) => tool.registration.id);
    const defNames = Object.keys(defs);

    return {
      toolIds,
      close: () =>
        Effect.gen(function* () {
          yield* input.registry.unregisterRuntime(toolIds);
          yield* input.registry.unregisterRuntimeDefinitions(defNames);
          if (input.source && input.sources) {
            yield* input.sources.unregisterRuntime(input.source.id);
          }
        }),
    };
  });
