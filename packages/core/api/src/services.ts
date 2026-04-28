import { Context } from "effect";
import type * as Cause from "effect/Cause";
import type { Executor } from "@executor/sdk";
import type { ExecutionEngine } from "@executor/execution";

export class ExecutorService extends Context.Tag("ExecutorService")<
  ExecutorService,
  Executor
>() {}

// Error channel widened to `Cause.YieldableError` so callers that plug
// in a runtime-specific tagged error (e.g.
// `ExecutionEngine<DynamicWorkerExecutionError>`) assign structurally.
// Handlers yield directly; defects flow through `Effect.catchAllCause`
// at the edge.
export class ExecutionEngineService extends Context.Tag("ExecutionEngineService")<
  ExecutionEngineService,
  ExecutionEngine<Cause.YieldableError>
>() {}
