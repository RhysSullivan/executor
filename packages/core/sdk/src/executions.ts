import { Context, Effect, Schema } from "effect";

import { ExecutionId, ExecutionInteractionId, ExecutionToolCallId, ScopeId } from "./ids";

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
  triggerKind: Schema.NullOr(Schema.String),
  triggerMetaJson: Schema.NullOr(Schema.String),
  toolCallCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

export const ExecutionInteractionStatus = Schema.Literal("pending", "resolved", "cancelled");
export type ExecutionInteractionStatus = typeof ExecutionInteractionStatus.Type;

export class ExecutionInteraction extends Schema.Class<ExecutionInteraction>(
  "ExecutionInteraction",
)({
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

export const ExecutionToolCallStatus = Schema.Literal("running", "completed", "failed");
export type ExecutionToolCallStatus = typeof ExecutionToolCallStatus.Type;

export class ExecutionToolCall extends Schema.Class<ExecutionToolCall>("ExecutionToolCall")({
  id: ExecutionToolCallId,
  executionId: ExecutionId,
  status: ExecutionToolCallStatus,
  /** Full dotted path, e.g. `"github.listIssues"`. */
  toolPath: Schema.String,
  /** First path segment, e.g. `"github"`. Useful for facet grouping. */
  namespace: Schema.String,
  argsJson: Schema.NullOr(Schema.String),
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
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
    | "toolCallCount"
    | "updatedAt"
  >
>;

export type CreateExecutionInteractionInput = Omit<ExecutionInteraction, "id">;
export type UpdateExecutionInteractionInput = Partial<
  Pick<
    ExecutionInteraction,
    | "status"
    | "kind"
    | "purpose"
    | "payloadJson"
    | "responseJson"
    | "responsePrivateJson"
    | "updatedAt"
  >
>;

export type CreateExecutionToolCallInput = Omit<ExecutionToolCall, "id">;
export type UpdateExecutionToolCallInput = Partial<
  Pick<ExecutionToolCall, "status" | "resultJson" | "errorText" | "completedAt" | "durationMs">
>;

export type ExecutionSortField = "createdAt" | "durationMs";
export type ExecutionSortDirection = "asc" | "desc";
export interface ExecutionSort {
  readonly field: ExecutionSortField;
  readonly direction: ExecutionSortDirection;
}

export interface ExecutionListOptions {
  readonly limit: number;
  readonly cursor?: string;
  readonly statusFilter?: readonly ExecutionStatus[];
  readonly triggerFilter?: readonly string[];
  /** Glob patterns: exact match or trailing wildcard (`a.*`). */
  readonly toolPathFilter?: readonly string[];
  readonly timeRange?: {
    readonly from?: number;
    readonly to?: number;
  };
  readonly codeQuery?: string;
  /** Filter by whether the run recorded any interaction. */
  readonly hadElicitation?: boolean;
  /** Return only rows created after this timestamp. */
  readonly after?: number;
  /** Sort order. Defaults to createdAt desc. */
  readonly sort?: ExecutionSort;
  /** When true, compute and return ExecutionListMeta. */
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

export interface ExecutionToolFacet {
  readonly toolPath: string;
  readonly count: number;
}

export interface ExecutionListMeta {
  readonly totalRowCount: number;
  readonly filterRowCount: number;
  readonly chartBucketMs: number;
  readonly chartData: readonly ExecutionChartBucket[];
  readonly statusCounts: Readonly<Record<ExecutionStatus, number>>;
  /** Count of executions per `triggerKind`. Includes `"unknown"` for nulls. */
  readonly triggerCounts: Readonly<Record<string, number>>;
  /** Top-N tool paths by invocation count across the filtered set. */
  readonly toolFacets: readonly ExecutionToolFacet[];
  readonly interactionCounts: {
    readonly withElicitation: number;
    readonly withoutElicitation: number;
  };
}

export const EXECUTION_STATUS_KEYS = [
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly ExecutionStatus[];

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

export interface BuildExecutionListMetaInput {
  readonly filtered: readonly Execution[];
  readonly timeRange: ExecutionListOptions["timeRange"];
  readonly totalRowCount: number;
  /** Tool path invocation counts for populating toolFacets. */
  readonly toolPathCounts?: ReadonlyMap<string, number>;
  /** Execution IDs with at least one interaction, for computing interactionCounts. */
  readonly executionIdsWithInteractions?: ReadonlySet<ExecutionId>;
}

const TRIGGER_KIND_UNKNOWN = "unknown";

export const buildExecutionListMeta = (input: BuildExecutionListMetaInput): ExecutionListMeta => {
  const { filtered, timeRange, totalRowCount, toolPathCounts, executionIdsWithInteractions } =
    input;
  const filterRowCount = filtered.length;

  const statusCounts: Record<ExecutionStatus, number> = {
    pending: 0,
    running: 0,
    waiting_for_interaction: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  const triggerCounts: Record<string, number> = {};
  let withElicitation = 0;
  for (const execution of filtered) {
    statusCounts[execution.status] += 1;
    const key = execution.triggerKind ?? TRIGGER_KIND_UNKNOWN;
    triggerCounts[key] = (triggerCounts[key] ?? 0) + 1;
    if (executionIdsWithInteractions?.has(execution.id)) {
      withElicitation += 1;
    }
  }
  const interactionCounts = {
    withElicitation,
    withoutElicitation: filterRowCount - withElicitation,
  };

  const toolFacets: ExecutionToolFacet[] = toolPathCounts
    ? [...toolPathCounts.entries()]
        .map(([toolPath, count]) => ({ toolPath, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)
    : [];

  if (filterRowCount === 0) {
    return {
      totalRowCount,
      filterRowCount,
      chartBucketMs: pickChartBucketMs(0),
      chartData: [],
      statusCounts,
      triggerCounts,
      toolFacets,
      interactionCounts,
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
    triggerCounts,
    toolFacets,
    interactionCounts,
  };
};

/**
 * Match a tool path against a filter pattern. Supports exact match
 * and trailing glob (`github.*` matches any `github.<tail>`).
 */
export const matchToolPathPattern = (toolPath: string, pattern: string): boolean => {
  if (pattern === toolPath) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep trailing `.`
    return toolPath.startsWith(prefix);
  }
  return false;
};

const computeDuration = (execution: Execution): number | null => {
  if (execution.startedAt === null || execution.completedAt === null) return null;
  return Math.max(0, execution.completedAt - execution.startedAt);
};

/**
 * Comparator suitable for `Array.prototype.sort`. Returns `< 0` when
 * `a` should come before `b`. Tie-breaks on `id` DESC for stable
 * ordering. Rows with `null` duration sort to the end regardless of
 * direction.
 */
export const pickExecutionSorter = (
  sort: ExecutionSort | undefined,
): ((a: Execution, b: Execution) => number) => {
  if (!sort || sort.field === "createdAt") {
    const ascending = sort?.direction === "asc";
    return (a, b) => {
      const delta = a.createdAt - b.createdAt;
      if (delta !== 0) return ascending ? delta : -delta;
      return b.id.localeCompare(a.id);
    };
  }

  // durationMs
  const ascending = sort.direction === "asc";
  return (a, b) => {
    const da = computeDuration(a);
    const db = computeDuration(b);
    if (da === null && db === null) return b.id.localeCompare(a.id);
    if (da === null) return 1;
    if (db === null) return -1;
    const delta = da - db;
    if (delta !== 0) return ascending ? delta : -delta;
    return b.id.localeCompare(a.id);
  };
};

export class ExecutionStore extends Context.Tag("@executor/sdk/ExecutionStore")<
  ExecutionStore,
  {
    readonly create: (input: CreateExecutionInput) => Effect.Effect<Execution>;
    readonly update: (id: ExecutionId, patch: UpdateExecutionInput) => Effect.Effect<Execution>;
    readonly list: (
      scopeId: ScopeId,
      options: ExecutionListOptions,
    ) => Effect.Effect<{
      readonly executions: readonly ExecutionListItem[];
      readonly nextCursor?: string;
      readonly meta?: ExecutionListMeta;
    }>;
    readonly get: (id: ExecutionId) => Effect.Effect<{
      readonly execution: Execution;
      readonly pendingInteraction: ExecutionInteraction | null;
    } | null>;
    readonly recordInteraction: (
      executionId: ExecutionId,
      interaction: CreateExecutionInteractionInput,
    ) => Effect.Effect<ExecutionInteraction>;
    readonly resolveInteraction: (
      interactionId: ExecutionInteractionId,
      patch: UpdateExecutionInteractionInput,
    ) => Effect.Effect<ExecutionInteraction>;
    /** Record the start of a tool call; returns the created row. */
    readonly recordToolCall: (
      input: CreateExecutionToolCallInput,
    ) => Effect.Effect<ExecutionToolCall>;
    readonly finishToolCall: (
      id: ExecutionToolCallId,
      patch: UpdateExecutionToolCallInput,
    ) => Effect.Effect<ExecutionToolCall>;
    /** List tool calls for an execution, ordered by start time. */
    readonly listToolCalls: (
      executionId: ExecutionId,
    ) => Effect.Effect<readonly ExecutionToolCall[]>;
    readonly sweep: () => Effect.Effect<void>;
  }
>() {}
