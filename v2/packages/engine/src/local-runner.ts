import type { Source } from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";

import {
  ToolProviderRegistryError,
  ToolProviderRegistryService,
  type CanonicalToolDescriptor,
  type ToolProviderError,
} from "./tool-providers";

export class LocalCodeRunnerError extends Data.TaggedError("LocalCodeRunnerError")<{
  operation: string;
  message: string;
  details: string | null;
}> {
}

export type RunnableTool = {
  descriptor: CanonicalToolDescriptor;
  source: Source | null;
};

export type ExecuteJavaScriptInput = {
  code: string;
  tools: ReadonlyArray<RunnableTool>;
};

const duplicateToolIdError = (toolId: string): LocalCodeRunnerError =>
  new LocalCodeRunnerError({
    operation: "build_tools",
    message: `Duplicate tool id in run context: ${toolId}`,
    details: null,
  });

const toolCallFailedError = (toolId: string): LocalCodeRunnerError =>
  new LocalCodeRunnerError({
    operation: "invoke_tool",
    message: `Tool call returned error: ${toolId}`,
    details: null,
  });

const toExecutionError = (cause: unknown): LocalCodeRunnerError =>
  new LocalCodeRunnerError({
    operation: "execute",
    message: "JavaScript execution failed",
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

const buildToolBindings = (
  tools: ReadonlyArray<RunnableTool>,
): Effect.Effect<Map<string, RunnableTool>, LocalCodeRunnerError> =>
  Effect.gen(function* () {
    const byToolId = new Map<string, RunnableTool>();

    for (const tool of tools) {
      const toolId = tool.descriptor.toolId;
      if (byToolId.has(toolId)) {
        return yield* duplicateToolIdError(toolId);
      }
      byToolId.set(toolId, tool);
    }

    return byToolId;
  });
// todo: run in sandbox
const runJavaScript = (
  code: string,
  toolsObject: Record<string, (args: unknown) => Promise<unknown>>,
): Effect.Effect<unknown, LocalCodeRunnerError> =>
  Effect.tryPromise({
    try: async () => {
      const execute = new Function(
        "tools",
        `"use strict"; return (async () => {\n${code}\n})();`,
      ) as (tools: Record<string, (args: unknown) => Promise<unknown>>) =>
          Promise<unknown>;

      return await execute(toolsObject);
    },
    catch: toExecutionError,
  });

export const executeJavaScriptWithTools = (
  input: ExecuteJavaScriptInput,
): Effect.Effect<
  unknown,
  LocalCodeRunnerError | ToolProviderRegistryError | ToolProviderError,
  ToolProviderRegistryService
> =>
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
              Effect.flatMap((result) =>
                result.isError
                  ? toolCallFailedError(toolId)
                  : Effect.succeed(result.output),
              ),
            ),
        );
    }

    return yield* runJavaScript(input.code, toolsObject);
  });
