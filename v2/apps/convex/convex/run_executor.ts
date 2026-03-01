import {
  RunExecutionService,
  RunExecutionServiceLive,
} from "@executor-v2/domain";
import type { ExecuteRunInput, ExecuteRunResult } from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ConvexRuntimeExecutionPortLive } from "./runtime_execution_port";

export type ConvexRunExecutorService = {
  executeRun: (input: ExecuteRunInput) => Effect.Effect<ExecuteRunResult>;
};

export class ConvexRunExecutor extends Context.Tag(
  "@executor-v2/app-convex/ConvexRunExecutor",
)<ConvexRunExecutor, ConvexRunExecutorService>() {}

const ConvexRunExecutionLive = RunExecutionServiceLive().pipe(
  Layer.provide(ConvexRuntimeExecutionPortLive),
);

export const ConvexRunExecutorLive = Layer.effect(
  ConvexRunExecutor,
  Effect.gen(function* () {
    const runExecutionService = yield* RunExecutionService;

    return ConvexRunExecutor.of({
      executeRun: (input) => runExecutionService.executeRun(input),
    });
  }),
).pipe(Layer.provide(ConvexRunExecutionLive));

