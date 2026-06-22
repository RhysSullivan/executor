import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import { InternalError } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExecuteRequest = Schema.Struct({
  code: Schema.String,
});

const StartCellRequest = Schema.Struct({
  code: Schema.String,
  yieldAfterMs: Schema.optional(Schema.Number),
});

const CompletedResult = Schema.Struct({
  status: Schema.Literal("completed"),
  text: Schema.String,
  structured: Schema.Unknown,
  isError: Schema.Boolean,
});

const PausedResult = Schema.Struct({
  status: Schema.Literal("paused"),
  text: Schema.String,
  structured: Schema.Unknown,
});

const ExecuteResponse = Schema.Union([CompletedResult, PausedResult]);

const CellObservation = Schema.Struct({
  status: Schema.Literals(["running", "completed", "failed", "terminated"]),
  cellId: Schema.String,
  cursor: Schema.Number,
  events: Schema.Array(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});

const ResumeRequest = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optional(Schema.Unknown),
});

const ResumeResponse = Schema.Union([CompletedResult, PausedResult]);

const PausedExecutionInfo = Schema.Struct({
  text: Schema.String,
  structured: Schema.Unknown,
});

const ExecutionNotFoundError = Schema.TaggedStruct("ExecutionNotFoundError", {
  executionId: Schema.String,
}).annotate({ httpApiStatus: 404 });

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ExecutionParams = { executionId: Schema.String };
const CellParams = { cellId: Schema.String };
const CellWaitQuery = Schema.Struct({
  after: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ExecutionsApi = HttpApiGroup.make("executions")
  .add(
    HttpApiEndpoint.post("execute", "/executions", {
      payload: ExecuteRequest,
      success: ExecuteResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("startCell", "/execution-cells", {
      payload: StartCellRequest,
      success: CellObservation,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("waitCell", "/execution-cells/:cellId", {
      params: CellParams,
      query: CellWaitQuery,
      success: CellObservation,
      error: [InternalError, ExecutionNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post("terminateCell", "/execution-cells/:cellId/terminate", {
      params: CellParams,
      success: CellObservation,
      error: [InternalError, ExecutionNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getPaused", "/executions/:executionId", {
      params: ExecutionParams,
      success: PausedExecutionInfo,
      error: [InternalError, ExecutionNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/executions/:executionId/resume", {
      params: ExecutionParams,
      payload: ResumeRequest,
      success: ResumeResponse,
      error: [InternalError, ExecutionNotFoundError],
    }),
  );
