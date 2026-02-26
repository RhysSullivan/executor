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
}> {}

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

const formatToolErrorDetails = (output: unknown): string | null => {
  if (output === undefined) {
    return null;
  }

  if (typeof output === "string") {
    return output;
  }

  try {
    const serialized = JSON.stringify(output, null, 2);
    return typeof serialized === "string" ? serialized : String(output);
  } catch {
    return String(output);
  }
};

const toolCallFailedError = (
  toolId: string,
  output: unknown,
): LocalCodeRunnerError => {
  const details = formatToolErrorDetails(output);
  const baseMessage = `Tool call returned error: ${toolId}`;

  return new LocalCodeRunnerError({
    operation: "invoke_tool",
    message: details ? `${baseMessage}\n${details}` : baseMessage,
    details,
  });
};

const toExecutionError = (cause: unknown): LocalCodeRunnerError => {
  let details = cause instanceof Error ? cause.stack ?? cause.message : String(cause);

  if (typeof cause === "object" && cause !== null && "details" in cause) {
    const causeDetails = (cause as { details?: unknown }).details;
    if (typeof causeDetails === "string" && causeDetails.length > 0) {
      details = `${details}\n${causeDetails}`;
    }
  }

  return new LocalCodeRunnerError({
    operation: "execute",
    message: "JavaScript execution failed",
    details,
  });
};

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

const assignToolBinding = (
  toolsRoot: Record<string, unknown>,
  toolId: string,
  callTool: (args: unknown) => Promise<unknown>,
): void => {
  toolsRoot[toolId] = callTool;

  const segments = toolId.split(".").filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return;
  }

  let cursor: Record<string, unknown> = toolsRoot;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const current = cursor[segment];

    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      const next = Object.create(null) as Record<string, unknown>;
      cursor[segment] = next;
      cursor = next;
      continue;
    }

    cursor = current as Record<string, unknown>;
  }

  const leafSegment = segments[segments.length - 1];
  cursor[leafSegment] = callTool;
};

const runJavaScript = (
  code: string,
  toolsObject: Record<string, unknown>,
): Effect.Effect<unknown, LocalCodeRunnerError> =>
  Effect.tryPromise({
    try: async () => {
      const execute = new Function(
        "tools",
        `"use strict"; return (async () => {\n${code}\n})();`,
      ) as (tools: Record<string, unknown>) => Promise<unknown>;

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

    const toolsObject: Record<string, unknown> = Object.create(null);

    for (const [toolId, binding] of toolBindings.entries()) {
      assignToolBinding(toolsObject, toolId, (args: unknown) =>
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
                  ? toolCallFailedError(toolId, result.output)
                  : Effect.succeed(result.output),
              ),
            ),
        ),
      );
    }

    return yield* runJavaScript(input.code, toolsObject);
  });
