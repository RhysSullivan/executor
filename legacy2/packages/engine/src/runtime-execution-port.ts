import type { ExecuteRunInput } from "@executor-v2/sdk";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class RuntimeExecutionPortError extends Data.TaggedError(
  "RuntimeExecutionPortError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export type ExecuteRuntimeRunInput = ExecuteRunInput & {
  runId: string;
};

export type ExecuteRuntimeRun = (
  input: ExecuteRuntimeRunInput,
) => Effect.Effect<unknown, RuntimeExecutionPortError>;
