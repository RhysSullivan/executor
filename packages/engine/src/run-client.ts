import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import type { RuntimeAdapter, RuntimeExecuteError } from "./runtime-adapters";
import { createRuntimeToolCallService, type ToolRegistry } from "./tool-registry";

export type RuntimeRunClientExecuteInput = {
  code: string;
  timeoutMs?: number;
};

export type RuntimeRunClientExecuteResult = {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "denied" | "waiting_for_interaction";
  result?: unknown;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  interactionId?: string;
};

export type RuntimeRunClient = {
  execute: (
    input: RuntimeRunClientExecuteInput,
  ) => Promise<RuntimeRunClientExecuteResult>;
};

export type CreateRuntimeRunClientOptions = {
  runtimeAdapter: RuntimeAdapter;
  toolRegistry: ToolRegistry;
  defaults?: {
    timeoutMs?: number;
  };
  makeRunId?: () => string;
};

const formatRuntimeExecuteError = (error: RuntimeExecuteError): string =>
  error.details ? `${error.message}: ${error.details}` : error.message;

export const createRuntimeRunClient = (
  options: CreateRuntimeRunClientOptions,
): RuntimeRunClient => {
  const runIdFactory = options.makeRunId ?? (() => `run_${crypto.randomUUID()}`);
  const toolCallService = createRuntimeToolCallService(options.toolRegistry);

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
          error: "Runtime availability check failed",
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
          options.runtimeAdapter.execute({
            runId,
            code: input.code,
            timeoutMs: input.timeoutMs ?? options.defaults?.timeoutMs,
            toolCallService,
          }),
        ),
      );

      if (Either.isLeft(executionResult)) {
        return {
          runId,
          status: "failed",
          error: formatRuntimeExecuteError(executionResult.left),
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

