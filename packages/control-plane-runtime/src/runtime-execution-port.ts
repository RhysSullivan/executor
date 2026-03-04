import {
  createRuntimeToolCallService,
  RuntimeExecutionPortError,
  type ExecuteRuntimeRun,
  type ExecuteRuntimeRunInput,
  type RuntimeAdapterRegistry,
  type RuntimeExecuteError,
  type ToolRegistry,
} from "@executor-v2/engine";
import * as Effect from "effect/Effect";

export type RuntimeHostExecutionPortOptions = {
  defaultRuntimeKind: string;
  runtimeAdapters: RuntimeAdapterRegistry;
  toolRegistry: ToolRegistry;
};

export const createRuntimeHostExecuteRuntimeRun = (
  options: RuntimeHostExecutionPortOptions,
): ExecuteRuntimeRun => {
  const runtimeToolCallService = createRuntimeToolCallService(options.toolRegistry);

  return (input: ExecuteRuntimeRunInput) =>
    Effect.gen(function* () {
      const runtimeAdapter = yield* options.runtimeAdapters
        .get(options.defaultRuntimeKind)
        .pipe(
          Effect.mapError(
            (error) =>
              new RuntimeExecutionPortError({
                operation: "resolve_runtime_adapter",
                message: error.message,
                details: null,
              }),
          ),
        );

        const isAvailable = yield* runtimeAdapter.isAvailable();
        if (!isAvailable) {
          return yield* new RuntimeExecutionPortError({
            operation: "runtime_available",
            message: `Runtime '${options.defaultRuntimeKind}' is not available in this runtime host process.`,
            details: null,
          });
        }

      return yield* runtimeAdapter
        .execute({
          runId: input.runId,
          code: input.code,
          timeoutMs: input.timeoutMs,
          toolCallService: runtimeToolCallService,
        })
        .pipe(
          Effect.mapError(
            (error: RuntimeExecuteError) =>
              new RuntimeExecutionPortError({
                operation: "runtime_execute",
                message: error.message,
                details: JSON.stringify({
                  runtimeOperation: error.operation,
                  runtimeKind: error.runtimeKind,
                  details: error.details,
                }),
              }),
          ),
        );
    });
};
