import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExecuteRequest = Schema.Struct({
  code: Schema.String,
});

/**
 * Optional header naming the surface that triggered this execution —
 * `"cli"`, `"http"`, `"mcp"`, etc. Persisted on the execution row so
 * the runs UI can facet by trigger kind. Defaults to `"http"` when
 * absent.
 */
const ExecuteHeaders = Schema.Struct({
  "x-executor-trigger": Schema.optional(Schema.String),
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

const ExecuteResponse = Schema.Union(CompletedResult, PausedResult);

const ResumeRequest = Schema.Struct({
  action: Schema.Literal("accept", "decline", "cancel"),
  content: Schema.optional(Schema.Unknown),
});

const ResumeResponse = Schema.Struct({
  text: Schema.String,
  structured: Schema.Unknown,
  isError: Schema.Boolean,
});

const ExecutionNotFoundError = Schema.TaggedStruct("ExecutionNotFoundError", {
  executionId: Schema.String,
}).annotations(HttpApiSchema.annotations({ status: 404 }));

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const executionIdParam = HttpApiSchema.param("executionId", Schema.String);

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class ExecutionsApi extends HttpApiGroup.make("executions")
  .add(
    HttpApiEndpoint.post("execute")`/executions`
      .setPayload(ExecuteRequest)
      .setHeaders(ExecuteHeaders)
      .addSuccess(ExecuteResponse),
  )
  .add(
    HttpApiEndpoint.post("resume")`/executions/${executionIdParam}/resume`
      .setPayload(ResumeRequest)
      .addSuccess(ResumeResponse)
      .addError(ExecutionNotFoundError),
  )
  .addError(InternalError) {}
