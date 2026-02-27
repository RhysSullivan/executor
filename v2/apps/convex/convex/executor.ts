import {
  RunExecutionService,
  RunExecutionServiceLive,
} from "@executor-v2/domain";
import {
  RuntimeAdapterRegistryLive,
  ToolProviderRegistryService,
  makeLocalInProcessRuntimeAdapter,
  makeToolProviderRegistry,
} from "@executor-v2/engine";
import type { ExecuteRunInput, ExecuteRunResult } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const ConvexRuntimeExecutionDependenciesLive = Layer.merge(
  RuntimeAdapterRegistryLive([makeLocalInProcessRuntimeAdapter()]),
  Layer.succeed(ToolProviderRegistryService, makeToolProviderRegistry([])),
);

const ConvexRunExecutionLive = RunExecutionServiceLive({
  target: "convex",
  defaultRuntimeKind: "local-inproc",
}).pipe(Layer.provide(ConvexRuntimeExecutionDependenciesLive));

export const executeRunImpl = (
  input: ExecuteRunInput,
): Effect.Effect<ExecuteRunResult> =>
  Effect.gen(function* () {
    const runExecutionService = yield* RunExecutionService;
    return yield* runExecutionService.executeRun(input);
  }).pipe(Effect.provide(ConvexRunExecutionLive));
