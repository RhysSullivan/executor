import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExecuteRequest = Schema.Struct({
  code: Schema.String,
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
      .addSuccess(ExecuteResponse),
  )
  .add(
    HttpApiEndpoint.post("resume")`/executions/${executionIdParam}/resume`
      .setPayload(ResumeRequest)
      .addSuccess(ResumeResponse)
      .addError(ExecutionNotFoundError),
  )
  {}
