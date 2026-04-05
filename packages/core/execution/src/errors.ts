import * as Data from "effect/Data";

export class ExecutionToolError extends Data.TaggedError("ExecutionToolError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
