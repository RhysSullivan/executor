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
  /**
   * Label identifying which execution entry point started this run —
   * `"mcp"`, `"http"`, `"cli"`, `"test"`, etc. Whether an `mcp` run
   * actually elicited the user is tracked separately via the
   * `hadElicitation` filter (derived from `execution_interactions`).
   * Null for rows recorded before this field existed (migration 0003).
   */
  triggerKind: Schema.NullOr(Schema.String),
  /**
   * Free-form caller metadata stringified as JSON (session id, user
   * agent, mcp client name, etc.). Escape hatch for per-entry-point
   * context without adding columns.
   */
  triggerMetaJson: Schema.NullOr(Schema.String),
  /**
   * Number of `tools.*.*` invocations the sandbox made during this
   * execution. Populated at terminal state from a Ref held by the
   * engine's tool-invoker wrapper. Does not include internal
   * engine calls like `search` / `describe.tool`.
   */
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

/**
 * One sandbox tool invocation recorded as part of an execution. Every
 * `tools.<namespace>.<tool>(args)` call made by user code gets a row
 * here, written at call start (status `running`) and finalized at
 * call end (status `completed` or `failed`).
 *
 * We store args + result as raw JSON strings for display in the
 * drawer timeline — no projection or indexing beyond `toolPath`.
 */
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

/**
 * Supported sort field for the executions list. Kept narrow — only
 * numeric / ordinal fields where sort order has intuitive meaning.
 */
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
  /**
   * Filter executions that made at least one tool call matching one
   * of these patterns. Patterns support exact match (`github.listIssues`)
   * and glob tail (`github.*` → prefix `github.`).
   */
  readonly toolPathFilter?: readonly string[];
  readonly timeRange?: {
    readonly from?: number;
    readonly to?: number;
  };
  readonly codeQuery?: string;
  /**
   * Filter by whether the execution recorded at least one
   * {@link ExecutionInteraction}. `true` → only runs that elicited
   * the user. `false` → only runs that didn't. Omitted → no filter.
   *
   * Used by the /runs "Interactions" facet to separate autonomous
   * runs from ones that paused for user input, independent of the
   * `triggerKind` (which just records *who started* the run).
   */
  readonly hadElicitation?: boolean;
  /**
   * Live-mode floor: return only rows with `createdAt > after`. Used
   * by the `/runs` UI's live mode to fetch rows newer than the most
   * recent one we already have without duplicating the page window.
   */
  readonly after?: number;
  /**
   * Sort order for the page. Defaults to `{ field: "createdAt",
   * direction: "desc" }` when omitted (newest runs first). Stores that
   * implement this option should respect it for the page itself AND
   * for the filtered superset used to compute `meta`.
   */
  readonly sort?: ExecutionSort;
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

export interface ExecutionToolFacet {
  readonly toolPath: string;
  readonly count: number;
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
  /** Count of executions per `triggerKind`. Includes `"unknown"` for nulls. */
  readonly triggerCounts: Readonly<Record<string, number>>;
  /** Top-N tool paths by invocation count across the filtered set. */
  readonly toolFacets: readonly ExecutionToolFacet[];
  /**
   * Count of runs in the filtered set split by whether they recorded
   * any {@link ExecutionInteraction}. Used to populate the /runs
   * "Interactions" facet — `withElicitation + withoutElicitation`
   * should equal `filterRowCount`.
   */
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

export interface BuildExecutionListMetaInput {
  readonly filtered: readonly Execution[];
  readonly timeRange: ExecutionListOptions["timeRange"];
  readonly totalRowCount: number;
  /**
   * Count of tool invocations per `toolPath` across the filtered set.
   * Used to populate `toolFacets`. Stores pass this in from a separate
   * aggregation query; pass an empty map if the store has no tool-call
   * data yet.
   */
  readonly toolPathCounts?: ReadonlyMap<string, number>;
  /**
   * Set of execution IDs from the *filtered* set that have at least
   * one recorded {@link ExecutionInteraction}. Used to compute
   * `meta.interactionCounts`. Stores pass this in from a separate
   * query against `execution_interactions`; defaults to empty if
   * omitted (implying no elicitation was used).
   */
  readonly executionIdsWithInteractions?: ReadonlySet<ExecutionId>;
}

const TRIGGER_KIND_UNKNOWN = "unknown";

/**
 * Build a chart + counts from a flat, already-filtered list of
 * executions. Shared by every {@link ExecutionStore} implementation so
 * the chart math lives in one place.
 */
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

// ---------------------------------------------------------------------------
// Execution comparators — shared sort logic for all stores
// ---------------------------------------------------------------------------

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
    /**
     * Record the start of a tool call. Returns the created row so the
     * engine can track the id for the matching `finishToolCall`.
     */
    readonly recordToolCall: (
      input: CreateExecutionToolCallInput,
    ) => Effect.Effect<ExecutionToolCall>;
    /**
     * Finalize a tool call with its result/error and duration.
     */
    readonly finishToolCall: (
      id: ExecutionToolCallId,
      patch: UpdateExecutionToolCallInput,
    ) => Effect.Effect<ExecutionToolCall>;
    /**
     * List every tool call recorded for an execution, in start-time
     * order. Used by the detail drawer's tool timeline.
     */
    readonly listToolCalls: (
      executionId: ExecutionId,
    ) => Effect.Effect<readonly ExecutionToolCall[]>;
    readonly sweep: () => Effect.Effect<void>;
  }
>() {}
