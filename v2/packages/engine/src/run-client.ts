import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import {
  ToolProviderError,
  ToolProviderRegistryService,
  makeToolProviderRegistry,
  type CanonicalToolDescriptor,
  type ToolProvider,
  type ToolProviderRegistry,
} from "./tool-providers";
import type { RuntimeAdapter, RuntimeRunnableTool } from "./runtime-adapters";

export type RuntimeRunClientExecuteInput = {
  code: string;
  timeoutMs?: number;
};

export type RuntimeRunClientExecuteResult = {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "denied";
  result?: unknown;
  error?: string;
  exitCode?: number;
  durationMs?: number;
};

export type RuntimeRunClient = {
  execute: (
    input: RuntimeRunClientExecuteInput,
  ) => Promise<RuntimeRunClientExecuteResult>;
};

export type InMemorySandboxTool = {
  description?: string | null;
  execute?: (...args: Array<any>) => Promise<any> | any;
};

export type InMemorySandboxToolMap = Record<string, InMemorySandboxTool>;

export type CreateRuntimeRunClientOptions = {
  runtimeAdapter: RuntimeAdapter;
  tools?: ReadonlyArray<RuntimeRunnableTool>;
  toolProviderRegistry: ToolProviderRegistry;
  defaults?: {
    timeoutMs?: number;
  };
  makeRunId?: () => string;
};

export type CreateInMemoryRuntimeRunClientOptions = {
  runtimeAdapter: RuntimeAdapter;
  tools: InMemorySandboxToolMap;
  defaults?: {
    timeoutMs?: number;
  };
  makeRunId?: () => string;
};

const errorToText = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return String(error);
};

const toInMemoryDescriptor = (
  toolName: string,
  tool: InMemorySandboxTool,
): CanonicalToolDescriptor => ({
  providerKind: "in_memory",
  sourceId: null,
  workspaceId: null,
  toolId: toolName,
  name: toolName,
  description: tool.description ?? null,
  invocationMode: "in_memory",
  availability: "local_only",
  providerPayload: null,
});

const makeInMemoryRuntimeTools = (
  tools: InMemorySandboxToolMap,
): ReadonlyArray<RuntimeRunnableTool> =>
  Object.entries(tools).map(([toolName, tool]) => ({
    descriptor: toInMemoryDescriptor(toolName, tool),
    source: null,
  }));

const makeInMemoryToolProvider = (
  tools: InMemorySandboxToolMap,
): ToolProvider => ({
  kind: "in_memory",
  invoke: (input) => {
    const implementation = tools[input.tool.toolId];

    if (!implementation) {
      return Effect.succeed({
        output: `Unknown in-memory tool: ${input.tool.toolId}`,
        isError: true,
      });
    }

    return Effect.tryPromise({
      try: async () => {
        if (!implementation.execute) {
          throw new Error(`In-memory tool '${input.tool.toolId}' has no execute function`);
        }

        return {
          output: await implementation.execute(input.args, undefined),
          isError: false,
        };
      },
      catch: (cause) =>
        new ToolProviderError({
          operation: "invoke",
          providerKind: "in_memory",
          message: `In-memory tool invocation failed: ${input.tool.toolId}`,
          details: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  },
});

export const createRuntimeRunClient = (
  options: CreateRuntimeRunClientOptions,
): RuntimeRunClient => {
  const runIdFactory = options.makeRunId ?? (() => `run_${crypto.randomUUID()}`);

  return {
    execute: async (
      input: RuntimeRunClientExecuteInput,
    ): Promise<RuntimeRunClientExecuteResult> => {
      const runId = runIdFactory();

      const availabilityResult = await Effect.runPromise(
        Effect.either(options.runtimeAdapter.isAvailable()),
      );

      if (Either.isLeft(availabilityResult)) {
        return {
          runId,
          status: "failed",
          error: errorToText(availabilityResult.left),
        };
      }

      if (!availabilityResult.right) {
        return {
          runId,
          status: "failed",
          error: `Runtime '${options.runtimeAdapter.kind}' is not available`,
        };
      }

      const executionResult = await Effect.runPromise(
        Effect.either(
          options.runtimeAdapter
            .execute({
              code: input.code,
              timeoutMs: input.timeoutMs ?? options.defaults?.timeoutMs,
              tools: options.tools ?? [],
            })
            .pipe(
              Effect.provideService(
                ToolProviderRegistryService,
                options.toolProviderRegistry,
              ),
            ),
        ),
      );

      if (Either.isLeft(executionResult)) {
        return {
          runId,
          status: "failed",
          error: errorToText(executionResult.left),
        };
      }

      return {
        runId,
        status: "completed",
        result: executionResult.right,
      };
    },
  };
};

export const createInMemoryRuntimeRunClient = (
  options: CreateInMemoryRuntimeRunClientOptions,
): RuntimeRunClient => {
  const toolProviderRegistry = makeToolProviderRegistry([
    makeInMemoryToolProvider(options.tools),
  ]);

  return createRuntimeRunClient({
    runtimeAdapter: options.runtimeAdapter,
    tools: makeInMemoryRuntimeTools(options.tools),
    toolProviderRegistry,
    defaults: options.defaults,
    makeRunId: options.makeRunId,
  });
};
