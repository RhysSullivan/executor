import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { Execution, ExecutionInteraction, ExecutionStatus, ExecutionToolCall } from "@executor/sdk";

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

const ExecutionSummary = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.String,
  status: ExecutionStatus,
  code: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  logsJson: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  completedAt: Schema.NullOr(Schema.Number),
  triggerKind: Schema.NullOr(Schema.String),
  triggerMetaJson: Schema.NullOr(Schema.String),
  toolCallCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  pendingInteraction: Schema.NullOr(ExecutionInteraction),
});

const ListExecutionsParams = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  trigger: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  from: Schema.optional(Schema.NumberFromString),
  to: Schema.optional(Schema.NumberFromString),
  after: Schema.optional(Schema.NumberFromString),
  code: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.String),
  elicitation: Schema.optional(Schema.String),
});

const ExecutionChartBucket = Schema.Struct({
  timestamp: Schema.Number,
  pending: Schema.Number,
  running: Schema.Number,
  waiting_for_interaction: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
  cancelled: Schema.Number,
});

const ExecutionToolFacet = Schema.Struct({
  toolPath: Schema.String,
  count: Schema.Number,
});

const ExecutionListMeta = Schema.Struct({
  totalRowCount: Schema.Number,
  filterRowCount: Schema.Number,
  chartBucketMs: Schema.Number,
  chartData: Schema.Array(ExecutionChartBucket),
  statusCounts: Schema.Struct({
    pending: Schema.Number,
    running: Schema.Number,
    waiting_for_interaction: Schema.Number,
    completed: Schema.Number,
    failed: Schema.Number,
    cancelled: Schema.Number,
  }),
  triggerCounts: Schema.Record({ key: Schema.String, value: Schema.Number }),
  toolFacets: Schema.Array(ExecutionToolFacet),
  interactionCounts: Schema.Struct({
    withElicitation: Schema.Number,
    withoutElicitation: Schema.Number,
  }),
});

const ListExecutionsResponse = Schema.Struct({
  executions: Schema.Array(ExecutionSummary),
  nextCursor: Schema.optional(Schema.String),
  meta: Schema.optional(ExecutionListMeta),
});

const ListToolCallsResponse = Schema.Struct({
  toolCalls: Schema.Array(ExecutionToolCall),
});

const ExecuteHeaders = Schema.Struct({
  "x-executor-trigger": Schema.optional(Schema.String),
});

const GetExecutionResponse = Schema.Struct({
  execution: Execution,
  pendingInteraction: Schema.NullOr(ExecutionInteraction),
});

const ExecutionNotFoundError = Schema.TaggedStruct("ExecutionNotFoundError", {
  executionId: Schema.String,
}).annotations(HttpApiSchema.annotations({ status: 404 }));

const executionIdParam = HttpApiSchema.param("executionId", Schema.String);

export class ExecutionsApi extends HttpApiGroup.make("executions")
  .add(
    HttpApiEndpoint.get("list")`/executions`
      .setUrlParams(ListExecutionsParams)
      .addSuccess(ListExecutionsResponse),
  )
  .add(
    HttpApiEndpoint.get("get")`/executions/${executionIdParam}`
      .addSuccess(GetExecutionResponse)
      .addError(ExecutionNotFoundError),
  )
  .add(
    HttpApiEndpoint.get("listToolCalls")`/executions/${executionIdParam}/tool-calls`
      .addSuccess(ListToolCallsResponse)
      .addError(ExecutionNotFoundError),
  )
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
  ) {}
