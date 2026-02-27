import {
  RuntimeAdapterRegistryService,
  ToolProviderRegistryService,
  type RuntimeAdapterKind,
  type RuntimeAdapterRegistry,
  type RuntimeExecuteError,
  type RuntimeRunnableTool,
  type ToolProviderRegistry,
} from "@executor-v2/engine";
import type { ExecuteRunInput, ExecuteRunResult } from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ExecuteRuntimeRunInput = ExecuteRunInput & {
  runtimeKind?: RuntimeAdapterKind;
  tools?: ReadonlyArray<RuntimeRunnableTool>;
};

export type RunExecutionServiceShape = {
  executeRun: (input: ExecuteRuntimeRunInput) => Effect.Effect<ExecuteRunResult>;
};

export class RunExecutionService extends Context.Tag(
  "@executor-v2/domain/RunExecutionService",
)<RunExecutionService, RunExecutionServiceShape>() {}

export type RunExecutionServiceOptions = {
  target: string;
  defaultRuntimeKind: RuntimeAdapterKind;
  makeRunId?: () => string;
};

const formatRuntimeExecuteError = (error: RuntimeExecuteError): string => {
  switch (error._tag) {
    case "RuntimeAdapterError":
    case "LocalCodeRunnerError":
    case "DenoSubprocessRunnerError":
    case "ToolProviderError":
      return error.details ? `${error.message}: ${error.details}` : error.message;
    case "ToolProviderRegistryError":
      return error.message;
  }
};

const runtimeUnavailableResult = (
  runId: string,
  target: string,
  runtimeKind: RuntimeAdapterKind,
): ExecuteRunResult => ({
  runId,
  status: "failed",
  error: `Runtime '${runtimeKind}' is not available in this ${target} process.`,
});

const executeFailedResult = (runId: string, error: string): ExecuteRunResult => ({
  runId,
  status: "failed",
  error,
});

const executeCompletedResult = (
  runId: string,
  result: unknown,
): ExecuteRunResult => ({
  runId,
  status: "completed",
  result,
});

export const makeRunExecutionService = (
  dependencies: {
    runtimeAdapters: RuntimeAdapterRegistry;
    toolProviders: ToolProviderRegistry;
  },
  options: RunExecutionServiceOptions,
): RunExecutionServiceShape => ({
  executeRun: Effect.fn("@executor-v2/domain/run-execution.executeRun")(
    function* (input: ExecuteRuntimeRunInput) {
      const runId = options.makeRunId?.() ?? `run_${crypto.randomUUID()}`;
      const runtimeKind = input.runtimeKind ?? options.defaultRuntimeKind;

      const runtimeAdapterResult = yield* Effect.either(
        dependencies.runtimeAdapters.get(runtimeKind),
      );
      if (runtimeAdapterResult._tag === "Left") {
        return executeFailedResult(runId, runtimeAdapterResult.left.message);
      }

      const runtimeAdapter = runtimeAdapterResult.right;
      const availabilityResult = yield* Effect.either(runtimeAdapter.isAvailable());
      if (availabilityResult._tag === "Left") {
        return executeFailedResult(runId, "Runtime availability check failed");
      }
      if (!availabilityResult.right) {
        return runtimeUnavailableResult(runId, options.target, runtimeKind);
      }

      const executionResult = yield* Effect.either(
        runtimeAdapter
          .execute({
            code: input.code,
            timeoutMs: input.timeoutMs,
            tools: input.tools ?? [],
          })
          .pipe(
            Effect.provideService(
              ToolProviderRegistryService,
              dependencies.toolProviders,
            ),
          ),
      );

      if (executionResult._tag === "Left") {
        return executeFailedResult(
          runId,
          formatRuntimeExecuteError(executionResult.left),
        );
      }

      return executeCompletedResult(runId, executionResult.right);
    },
  ),
});

export const RunExecutionServiceLive = (
  options: RunExecutionServiceOptions,
): Layer.Layer<
  RunExecutionService,
  never,
  RuntimeAdapterRegistryService | ToolProviderRegistryService
> =>
  Layer.effect(
    RunExecutionService,
    Effect.gen(function* () {
      const runtimeAdapters = yield* RuntimeAdapterRegistryService;
      const toolProviders = yield* ToolProviderRegistryService;

      return RunExecutionService.of(
        makeRunExecutionService(
          {
            runtimeAdapters,
            toolProviders,
          },
          options,
        ),
      );
    }),
  );
