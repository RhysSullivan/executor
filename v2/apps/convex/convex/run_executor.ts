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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ConvexRunExecutorService = {
  executeRun: (input: ExecuteRunInput) => Effect.Effect<ExecuteRunResult>;
};

export class ConvexRunExecutor extends Context.Tag(
  "@executor-v2/app-convex/ConvexRunExecutor",
)<ConvexRunExecutor, ConvexRunExecutorService>() {}

const ConvexRuntimeExecutionDependenciesLive = Layer.merge(
  RuntimeAdapterRegistryLive([makeLocalInProcessRuntimeAdapter()]),
  Layer.succeed(ToolProviderRegistryService, makeToolProviderRegistry([])),
);

const ConvexRunExecutionLive = RunExecutionServiceLive({
  target: "convex",
  defaultRuntimeKind: "local-inproc",
}).pipe(Layer.provide(ConvexRuntimeExecutionDependenciesLive));

export const ConvexRunExecutorLive = Layer.effect(
  ConvexRunExecutor,
  Effect.gen(function* () {
    const runExecutionService = yield* RunExecutionService;

    return ConvexRunExecutor.of({
      executeRun: (input) => runExecutionService.executeRun(input),
    });
  }),
).pipe(Layer.provide(ConvexRunExecutionLive));

export const ConvexToolProviderRegistryLive = Layer.succeed(
  ToolProviderRegistryService,
  makeToolProviderRegistry([]),
);
