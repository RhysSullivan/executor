import { Context, Effect, Schema } from "effect";

import { ExecutionId, ExecutionInteractionId, ScopeId } from "./ids";

export const ExecutionStatus = Schema.Literal(
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
);
export type ExecutionStatus = typeof ExecutionStatus.Type;

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
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

export const ExecutionInteractionStatus = Schema.Literal("pending", "resolved", "cancelled");
export type ExecutionInteractionStatus = typeof ExecutionInteractionStatus.Type;

export class ExecutionInteraction extends Schema.Class<ExecutionInteraction>("ExecutionInteraction")({
  id: ExecutionInteractionId,
  executionId: ExecutionId,
  status: ExecutionInteractionStatus,
  kind: Schema.String,
  purpose: Schema.String,
  payloadJson: Schema.String,
  responseJson: Schema.NullOr(Schema.String),
  responsePrivateJson: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

export type CreateExecutionInput = Omit<Execution, "id">;
export type UpdateExecutionInput = Partial<
  Pick<
    Execution,
    | "status"
    | "code"
    | "resultJson"
    | "errorText"
    | "logsJson"
    | "startedAt"
    | "completedAt"
    | "updatedAt"
  >
>;

export type CreateExecutionInteractionInput = Omit<ExecutionInteraction, "id">;
export type UpdateExecutionInteractionInput = Partial<
  Pick<
    ExecutionInteraction,
    "status" | "kind" | "purpose" | "payloadJson" | "responseJson" | "responsePrivateJson" | "updatedAt"
  >
>;

export interface ExecutionListOptions {
  readonly limit: number;
  readonly cursor?: string;
  readonly statusFilter?: readonly ExecutionStatus[];
  readonly timeRange?: {
    readonly from?: number;
    readonly to?: number;
  };
  readonly codeQuery?: string;
  /**
   * When true, the store computes and returns {@link ExecutionListMeta}
   * alongside the page. Typically requested only on the first page
   * (cursor === undefined) since the metadata is stable across pagination.
   */
  readonly includeMeta?: boolean;
}

export type ExecutionListItem = Execution & {
  readonly pendingInteraction: ExecutionInteraction | null;
};

/**
 * One bucket in the execution timeline chart. `timestamp` is the bucket
 * start in epoch-ms. The remaining keys are counts per status.
 */
export interface ExecutionChartBucket {
  readonly timestamp: number;
  readonly pending: number;
  readonly running: number;
  readonly waiting_for_interaction: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

/**
 * Metadata describing the full filtered result set, independent of the
 * current page. Used to drive status facets, counts, and the timeline
 * chart above the list.
 */
export interface ExecutionListMeta {
  readonly totalRowCount: number;
  readonly filterRowCount: number;
  readonly chartBucketMs: number;
  readonly chartData: readonly ExecutionChartBucket[];
  readonly statusCounts: Readonly<Record<ExecutionStatus, number>>;
}

export const EXECUTION_STATUS_KEYS = [
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly ExecutionStatus[];

/**
 * Pick a bucket size in milliseconds from a time range span. Mirrors
 * openstatus-data-table's calculatePeriod, just expressed as duration.
 */
export const pickChartBucketMs = (spanMs: number): number => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  if (spanMs <= 10 * MIN) return MIN; // 1 minute
  if (spanMs <= DAY) return 5 * MIN; // 5 minutes
  if (spanMs <= 7 * DAY) return HOUR; // 1 hour
  if (spanMs <= 30 * DAY) return 6 * HOUR; // 6 hours
  return DAY; // 1 day
};

type MutableBucket = {
  -readonly [K in keyof ExecutionChartBucket]: ExecutionChartBucket[K];
};

const emptyBucket = (timestamp: number): MutableBucket => ({
  timestamp,
  pending: 0,
  running: 0,
  waiting_for_interaction: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
});

/**
 * Build a chart + counts from a flat, already-filtered list of
 * executions. Shared by every {@link ExecutionStore} implementation so
 * the chart math lives in one place.
 */
export const buildExecutionListMeta = (
  filtered: readonly Execution[],
  timeRange: ExecutionListOptions["timeRange"],
  totalRowCount: number,
): ExecutionListMeta => {
  const filterRowCount = filtered.length;

  const statusCounts: Record<ExecutionStatus, number> = {
    pending: 0,
    running: 0,
    waiting_for_interaction: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const execution of filtered) {
    statusCounts[execution.status] += 1;
  }

  if (filterRowCount === 0) {
    return {
      totalRowCount,
      filterRowCount,
      chartBucketMs: pickChartBucketMs(0),
      chartData: [],
      statusCounts,
    };
  }

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const execution of filtered) {
    if (execution.createdAt < minTs) minTs = execution.createdAt;
    if (execution.createdAt > maxTs) maxTs = execution.createdAt;
  }

  const rangeStart = timeRange?.from ?? minTs;
  const rangeEnd = timeRange?.to ?? maxTs;
  const span = Math.max(rangeEnd - rangeStart, 0);
  const bucketMs = pickChartBucketMs(span);

  const firstBucket = Math.floor(rangeStart / bucketMs) * bucketMs;
  const lastBucket = Math.floor(rangeEnd / bucketMs) * bucketMs;

  const bucketCount = Math.max(1, Math.floor((lastBucket - firstBucket) / bucketMs) + 1);
  // Cap buckets so a misconfigured time range doesn't blow up the response.
  const safeBucketCount = Math.min(bucketCount, 500);
  const bucketMap = new Map<number, MutableBucket>();
  for (let i = 0; i < safeBucketCount; i += 1) {
    const ts = firstBucket + i * bucketMs;
    bucketMap.set(ts, emptyBucket(ts));
  }

  for (const execution of filtered) {
    const bucketStart = Math.floor(execution.createdAt / bucketMs) * bucketMs;
    let bucket = bucketMap.get(bucketStart);
    if (!bucket) {
      bucket = emptyBucket(bucketStart);
      bucketMap.set(bucketStart, bucket);
    }
    bucket[execution.status] += 1;
  }

  const chartData = [...bucketMap.values()].sort((a, b) => a.timestamp - b.timestamp);

  return {
    totalRowCount,
    filterRowCount,
    chartBucketMs: bucketMs,
    chartData,
    statusCounts,
  };
};

export class ExecutionStore extends Context.Tag("@executor/sdk/ExecutionStore")<
  ExecutionStore,
  {
    readonly create: (input: CreateExecutionInput) => Effect.Effect<Execution>;
    readonly update: (
      id: ExecutionId,
      patch: UpdateExecutionInput,
    ) => Effect.Effect<Execution>;
    readonly list: (
      scopeId: ScopeId,
      options: ExecutionListOptions,
    ) => Effect.Effect<{
      readonly executions: readonly ExecutionListItem[];
      readonly nextCursor?: string;
      readonly meta?: ExecutionListMeta;
    }>;
    readonly get: (
      id: ExecutionId,
    ) => Effect.Effect<
      | {
          readonly execution: Execution;
          readonly pendingInteraction: ExecutionInteraction | null;
        }
      | null
    >;
    readonly recordInteraction: (
      executionId: ExecutionId,
      interaction: CreateExecutionInteractionInput,
    ) => Effect.Effect<ExecutionInteraction>;
    readonly resolveInteraction: (
      interactionId: ExecutionInteractionId,
      patch: UpdateExecutionInteractionInput,
    ) => Effect.Effect<ExecutionInteraction>;
    readonly sweep: () => Effect.Effect<void>;
  }
>() {}
