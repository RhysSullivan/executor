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

const ExecutionStatusLiteral = Schema.Literal(
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
);

const ExecutionRecord = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.String,
  status: ExecutionStatusLiteral,
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
});

const ExecutionInteractionRecord = Schema.Struct({
  id: Schema.String,
  executionId: Schema.String,
  status: Schema.Literal("pending", "resolved", "cancelled"),
  kind: Schema.String,
  purpose: Schema.NullOr(Schema.String),
  payloadJson: Schema.NullOr(Schema.String),
  responseJson: Schema.NullOr(Schema.String),
  responsePrivateJson: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const ExecutionToolCallRecord = Schema.Struct({
  id: Schema.String,
  executionId: Schema.String,
  status: Schema.Literal("running", "completed", "failed"),
  toolPath: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  argsJson: Schema.NullOr(Schema.String),
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
});

const ExecutionListItemResponse = Schema.Struct({
  execution: ExecutionRecord,
  pendingInteraction: Schema.NullOr(ExecutionInteractionRecord),
});

const ExecutionStatusCount = Schema.Struct({
  status: ExecutionStatusLiteral,
  count: Schema.Number,
});
const ExecutionTriggerCount = Schema.Struct({
  triggerKind: Schema.NullOr(Schema.String),
  count: Schema.Number,
});
const ExecutionToolFacet = Schema.Struct({
  toolPath: Schema.String,
  count: Schema.Number,
});
const ExecutionChartBucket = Schema.Struct({
  bucketStart: Schema.Number,
  counts: Schema.Record({ key: Schema.String, value: Schema.Number }),
});
const ExecutionListMeta = Schema.Struct({
  totalRowCount: Schema.Number,
  filterRowCount: Schema.Number,
  statusCounts: Schema.Array(ExecutionStatusCount),
  triggerCounts: Schema.Array(ExecutionTriggerCount),
  toolFacets: Schema.Array(ExecutionToolFacet),
  interactionCounts: Schema.Struct({
    withElicitation: Schema.Number,
    withoutElicitation: Schema.Number,
  }),
  chartBucketMs: Schema.Number,
  chartData: Schema.Array(ExecutionChartBucket),
});

const ListExecutionsResponse = Schema.Struct({
  executions: Schema.Array(ExecutionListItemResponse),
  nextCursor: Schema.optional(Schema.String),
  meta: Schema.optional(ExecutionListMeta),
});

const GetExecutionResponse = Schema.Struct({
  execution: ExecutionRecord,
  pendingInteraction: Schema.NullOr(ExecutionInteractionRecord),
});

const ListToolCallsResponse = Schema.Struct({
  toolCalls: Schema.Array(ExecutionToolCallRecord),
});

/**
 * Query-string filters for `GET /executions`. Every param is optional
 * and arrives as a plain string so the client side doesn't need to
 * know about Effect Schema. The handler normalizes CSV fields and
 * validates enums.
 */
const ListExecutionsParams = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
  /** CSV of ExecutionStatus. Invalid values are dropped. */
  status: Schema.optional(Schema.String),
  /** CSV of trigger kinds. Use "unknown" to match rows with null. */
  trigger: Schema.optional(Schema.String),
  /** CSV of tool paths / globs (`github.*`). */
  tool: Schema.optional(Schema.String),
  from: Schema.optional(Schema.NumberFromString),
  to: Schema.optional(Schema.NumberFromString),
  after: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  /** `<field>,<direction>` — e.g. `createdAt,desc`. */
  sort: Schema.optional(Schema.String),
  /** `"true"` / `"false"` to filter to runs that did or didn't elicit. */
  elicitation: Schema.optional(Schema.String),
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
    HttpApiEndpoint.get(
      "listToolCalls",
    )`/executions/${executionIdParam}/tool-calls`
      .addSuccess(ListToolCallsResponse)
      .addError(ExecutionNotFoundError),
  )
  .addError(InternalError) {}
