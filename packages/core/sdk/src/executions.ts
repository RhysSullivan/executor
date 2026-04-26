// ---------------------------------------------------------------------------
// ExecutionStore — records one run per `engine.execute()` /
// `executeWithPause()`. Wraps the generic `DBAdapter` core tables
// (`execution`, `execution_interaction`, `execution_tool_call`) so
// every storage backend that implements the adapter contract gets
// execution history for free.
//
// The store itself is plain Effect code; the adapter is threaded in
// by `createExecutor` and exposed to callers as `executor.executions`.
// ---------------------------------------------------------------------------

import { Context, Effect, Schema } from "effect";
import type { StorageFailure } from "@executor/storage-core";

import { ExecutionId, ExecutionInteractionId, ExecutionToolCallId, ScopeId } from "./ids";

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

export const ExecutionStatus = Schema.Literal(
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
);
export type ExecutionStatus = typeof ExecutionStatus.Type;

export const EXECUTION_STATUS_KEYS = [
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
] as const;

export const ExecutionInteractionStatus = Schema.Literal(
  "pending",
  "resolved",
  "cancelled",
);
export type ExecutionInteractionStatus = typeof ExecutionInteractionStatus.Type;

export const ExecutionToolCallStatus = Schema.Literal(
  "running",
  "completed",
  "failed",
);
export type ExecutionToolCallStatus = typeof ExecutionToolCallStatus.Type;

// ---------------------------------------------------------------------------
// Row projections
// ---------------------------------------------------------------------------

export class Execution extends Schema.Class<Execution>("Execution")({
  id: ExecutionId,
  scopeId: ScopeId,
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
  createdAt: Schema.DateFromNumber,
  updatedAt: Schema.DateFromNumber,
}) {}

export class ExecutionInteraction extends Schema.Class<ExecutionInteraction>(
  "ExecutionInteraction",
)({
  id: ExecutionInteractionId,
  executionId: ExecutionId,
  status: ExecutionInteractionStatus,
  kind: Schema.String,
  purpose: Schema.NullOr(Schema.String),
  payloadJson: Schema.NullOr(Schema.String),
  responseJson: Schema.NullOr(Schema.String),
  responsePrivateJson: Schema.NullOr(Schema.String),
  createdAt: Schema.DateFromNumber,
  updatedAt: Schema.DateFromNumber,
}) {}

export class ExecutionToolCall extends Schema.Class<ExecutionToolCall>("ExecutionToolCall")({
  id: ExecutionToolCallId,
  executionId: ExecutionId,
  status: ExecutionToolCallStatus,
  toolPath: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  argsJson: Schema.NullOr(Schema.String),
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
}) {}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateExecutionInput {
  readonly id: ExecutionId;
  readonly scopeId: ScopeId;
  readonly status: ExecutionStatus;
  readonly code: string;
  readonly startedAt?: number;
  readonly triggerKind?: string;
  readonly triggerMetaJson?: string;
}

export interface UpdateExecutionInput {
  readonly status?: ExecutionStatus;
  readonly resultJson?: string | null;
  readonly errorText?: string | null;
  readonly logsJson?: string | null;
  readonly completedAt?: number;
  readonly toolCallCount?: number;
}

export interface CreateExecutionInteractionInput {
  readonly id: ExecutionInteractionId;
  readonly executionId: ExecutionId;
  readonly status: ExecutionInteractionStatus;
  readonly kind: string;
  readonly purpose?: string;
  readonly payloadJson?: string;
}

export interface UpdateExecutionInteractionInput {
  readonly status?: ExecutionInteractionStatus;
  readonly responseJson?: string | null;
  readonly responsePrivateJson?: string | null;
}

export interface CreateExecutionToolCallInput {
  readonly id: ExecutionToolCallId;
  readonly executionId: ExecutionId;
  readonly toolPath: string;
  readonly namespace?: string;
  readonly argsJson?: string;
  readonly startedAt: number;
}

export interface UpdateExecutionToolCallInput {
  readonly status: ExecutionToolCallStatus;
  readonly resultJson?: string | null;
  readonly errorText?: string | null;
  readonly completedAt: number;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Filters + sort
// ---------------------------------------------------------------------------

export type ExecutionSortField = "createdAt" | "durationMs";
export type ExecutionSortDirection = "asc" | "desc";
export interface ExecutionSort {
  readonly field: ExecutionSortField;
  readonly direction: ExecutionSortDirection;
}

export interface ExecutionTimeRange {
  readonly from?: number;
  readonly to?: number;
}

export interface ExecutionListOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly statusFilter?: readonly ExecutionStatus[];
  readonly triggerFilter?: readonly string[];
  readonly toolPathFilter?: readonly string[];
  readonly timeRange?: ExecutionTimeRange;
  readonly after?: string;
  readonly codeQuery?: string;
  readonly hadElicitation?: boolean;
  readonly sort?: ExecutionSort;
  readonly includeMeta?: boolean;
}

export interface ExecutionListItem {
  readonly execution: Execution;
  readonly pendingInteraction: ExecutionInteraction | null;
}

export interface ExecutionStatusCount {
  readonly status: ExecutionStatus;
  readonly count: number;
}

export interface ExecutionTriggerCount {
  readonly triggerKind: string | null;
  readonly count: number;
}

export interface ExecutionToolFacet {
  readonly toolPath: string;
  readonly count: number;
}

export interface ExecutionChartBucket {
  readonly bucketStart: number;
  readonly counts: Readonly<Record<ExecutionStatus, number>>;
}

export interface ExecutionInteractionCounts {
  readonly withElicitation: number;
  readonly withoutElicitation: number;
}

export interface ExecutionListMeta {
  readonly totalRowCount: number;
  readonly filterRowCount: number;
  readonly statusCounts: readonly ExecutionStatusCount[];
  readonly triggerCounts: readonly ExecutionTriggerCount[];
  readonly toolFacets: readonly ExecutionToolFacet[];
  readonly interactionCounts: ExecutionInteractionCounts;
  readonly chartBucketMs: number;
  readonly chartData: readonly ExecutionChartBucket[];
}

export interface ExecutionListResult {
  readonly executions: readonly ExecutionListItem[];
  readonly nextCursor?: string;
  readonly meta?: ExecutionListMeta;
}

export interface ExecutionDetail {
  readonly execution: Execution;
  readonly pendingInteraction: ExecutionInteraction | null;
}

// ---------------------------------------------------------------------------
// Store surface
//
// Exposed to callers as `executor.executions`. The engine writes on
// every lifecycle edge (create → update → record{Interaction,ToolCall}
// → finish). Read methods back the `/executions` HTTP API and the
// runs UI.
// ---------------------------------------------------------------------------

export interface ExecutionStoreService {
  readonly create: (
    input: CreateExecutionInput,
  ) => Effect.Effect<Execution, StorageFailure>;
  readonly update: (
    id: ExecutionId,
    patch: UpdateExecutionInput,
  ) => Effect.Effect<Execution, StorageFailure>;
  readonly get: (
    id: ExecutionId,
  ) => Effect.Effect<ExecutionDetail | null, StorageFailure>;
  readonly list: (
    scopeId: ScopeId,
    options?: ExecutionListOptions,
  ) => Effect.Effect<ExecutionListResult, StorageFailure>;
  readonly recordInteraction: (
    input: CreateExecutionInteractionInput,
  ) => Effect.Effect<ExecutionInteraction, StorageFailure>;
  readonly resolveInteraction: (
    id: ExecutionInteractionId,
    patch: UpdateExecutionInteractionInput,
  ) => Effect.Effect<ExecutionInteraction, StorageFailure>;
  readonly recordToolCall: (
    input: CreateExecutionToolCallInput,
  ) => Effect.Effect<ExecutionToolCall, StorageFailure>;
  readonly finishToolCall: (
    id: ExecutionToolCallId,
    patch: UpdateExecutionToolCallInput,
  ) => Effect.Effect<ExecutionToolCall, StorageFailure>;
  readonly listToolCalls: (
    executionId: ExecutionId,
  ) => Effect.Effect<readonly ExecutionToolCall[], StorageFailure>;
  /** Drop execution rows older than the retention window. Host calls
   *  this on a schedule; the SDK doesn't drive it. */
  readonly sweep: (
    olderThanMs: number,
  ) => Effect.Effect<number, StorageFailure>;
}

export class ExecutionStore extends Context.Tag("@executor/sdk/ExecutionStore")<
  ExecutionStore,
  ExecutionStoreService
>() {}
