import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";

import {
  RuntimeAdapterError,
  type RuntimeAdapter,
  type RuntimeRunnableTool,
  ToolProviderRegistryService,
} from "@executor-v2/engine";

const runtimeKind = "local-inproc";

export type ExecuteJavaScriptInput = {
  code: string;
  tools: ReadonlyArray<RuntimeRunnableTool>;
};

const runtimeError = (
  operation: string,
  message: string,
  details: string | null,
): RuntimeAdapterError =>
  new RuntimeAdapterError({
    operation,
    runtimeKind,
    message,
    details,
  });

const toRuntimeAdapterError = (error: {
  operation: string;
  message: string;
  details?: string | null;
}): RuntimeAdapterError => runtimeError(error.operation, error.message, error.details ?? null);

const duplicateToolIdError = (toolId: string): RuntimeAdapterError =>
  runtimeError("build_tools", `Duplicate tool id in run context: ${toolId}`, null);

const toolCallFailedError = (toolId: string): RuntimeAdapterError =>
  runtimeError("invoke_tool", `Tool call returned error: ${toolId}`, null);

const toExecutionError = (cause: unknown): RuntimeAdapterError =>
  cause instanceof RuntimeAdapterError
    ? cause
    : runtimeError(
        "execute",
        "JavaScript execution failed",
        cause instanceof Error ? cause.stack ?? cause.message : String(cause),
      );

const buildToolBindings = (
  tools: ReadonlyArray<RuntimeRunnableTool>,
): Effect.Effect<Map<string, RuntimeRunnableTool>, RuntimeAdapterError> =>
  Effect.gen(function* () {
    const byToolId = new Map<string, RuntimeRunnableTool>();

    for (const tool of tools) {
      const toolId = tool.descriptor.toolId;
      if (byToolId.has(toolId)) {
        return yield* duplicateToolIdError(toolId);
      }
      byToolId.set(toolId, tool);
    }

    return byToolId;
  });

const runJavaScript = (
  code: string,
  toolsObject: Record<string, (args: unknown) => Promise<unknown>>,
): Effect.Effect<unknown, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () => {
      const execute = new Function(
        "tools",
        `"use strict"; return (async () => {\n${code}\n})();`,
      ) as (tools: Record<string, (args: unknown) => Promise<unknown>>) => Promise<unknown>;

      return await execute(toolsObject);
    },
    catch: toExecutionError,
  });

export const executeJavaScriptWithTools = (
  input: ExecuteJavaScriptInput,
): Effect.Effect<unknown, RuntimeAdapterError, ToolProviderRegistryService> =>
  Effect.gen(function* () {
    const registry = yield* ToolProviderRegistryService;
    const runtime = yield* Effect.runtime<never>();
    const runPromise = Runtime.runPromise(runtime);
    const toolBindings = yield* buildToolBindings(input.tools);

    const toolsObject: Record<string, (args: unknown) => Promise<unknown>> =
      Object.create(null);

    for (const [toolId, binding] of toolBindings.entries()) {
      toolsObject[toolId] = (args: unknown) =>
        runPromise(
          registry
            .invoke({
              source: binding.source,
              tool: binding.descriptor,
              args,
            })
            .pipe(
              Effect.mapError(toRuntimeAdapterError),
              Effect.flatMap((result) =>
                result.isError
                  ? Effect.fail(toolCallFailedError(toolId))
                  : Effect.succeed(result.output),
              ),
            ),
        );
    }

    return yield* runJavaScript(input.code, toolsObject);
  });

export const makeLocalInProcessRuntimeAdapter = (): RuntimeAdapter => ({
  kind: runtimeKind,
  isAvailable: () => Effect.succeed(true),
  execute: (input) =>
    executeJavaScriptWithTools({
      code: input.code,
      tools: input.tools,
    }),
});

export type { RuntimeRunnableTool };
