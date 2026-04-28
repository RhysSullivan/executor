// ---------------------------------------------------------------------------
// makeExecutionStore — an ExecutionStoreService implementation backed by
// the generic `typedAdapter<CoreSchema>` surface. Used by createExecutor
// to expose `executor.executions`.
//
// Per-row JSON columns (`result_json`, `logs_json`, `payload_json`, …)
// are stored as opaque strings — the SDK does not inspect their shape.
// Callers pre-stringify when writing and parse when reading.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { StorageFailure, TypedAdapter } from "@executor/storage-core";

import type { CoreSchema } from "./core-schema";

// Row shape accepted by the row-to-class mappers. We can't rely on
// `RowOutput<CoreSchema, "...">` narrowing because `TypedAdapter.update`
// takes a `Partial<RowInput<S, M>>` payload — Partial strips every
// required field, so TypeScript falls back to a union of every row
// type in the schema. The mappers read fields by name with explicit
// `row.xxx as string` casts anyway, so typing the input as the base
// record that every `RowOutput` extends is just as safe.
type AdapterRow = Record<string, unknown>;
import { decodeCursor, encodeCursor } from "./cursor";
import {
  Execution,
  ExecutionInteraction,
  ExecutionToolCall,
  type ExecutionStoreService,
  type ExecutionListOptions,
  type ExecutionListResult,
  type ExecutionListItem,
  type ExecutionListMeta,
  type ExecutionChartBucket,
  type ExecutionStatus,
  type ExecutionStatusCount,
  type ExecutionTriggerCount,
  type ExecutionToolFacet,
  EXECUTION_STATUS_KEYS,
} from "./executions";
import {
  ExecutionId,
  ExecutionInteractionId,
  ExecutionToolCallId,
  ScopeId,
} from "./ids";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const toNumberOrNull = (value: unknown): number | null =>
  value == null ? null : Number(value);

const toStringOrNull = (value: unknown): string | null =>
  value == null ? null : (value as string);

const toDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(value as string | number);

const rowToExecution = (row: AdapterRow): Execution =>
  new Execution({
    id: ExecutionId.make(row.id as string),
    scopeId: ScopeId.make(row.scope_id as string),
    status: row.status as ExecutionStatus,
    code: row.code as string,
    resultJson: toStringOrNull(row.result_json),
    errorText: toStringOrNull(row.error_text),
    logsJson: toStringOrNull(row.logs_json),
    startedAt: toNumberOrNull(row.started_at),
    completedAt: toNumberOrNull(row.completed_at),
    triggerKind: toStringOrNull(row.trigger_kind),
    triggerMetaJson: toStringOrNull(row.trigger_meta_json),
    toolCallCount: Number(row.tool_call_count ?? 0),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });

const rowToInteraction = (row: AdapterRow): ExecutionInteraction =>
  new ExecutionInteraction({
    id: ExecutionInteractionId.make(row.id as string),
    executionId: ExecutionId.make(row.execution_id as string),
    status: row.status as ExecutionInteraction["status"],
    kind: row.kind as string,
    purpose: toStringOrNull(row.purpose),
    payloadJson: toStringOrNull(row.payload_json),
    responseJson: toStringOrNull(row.response_json),
    responsePrivateJson: toStringOrNull(row.response_private_json),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });

const rowToToolCall = (row: AdapterRow): ExecutionToolCall =>
  new ExecutionToolCall({
    id: ExecutionToolCallId.make(row.id as string),
    executionId: ExecutionId.make(row.execution_id as string),
    status: row.status as ExecutionToolCall["status"],
    toolPath: row.tool_path as string,
    namespace: toStringOrNull(row.namespace),
    argsJson: toStringOrNull(row.args_json),
    resultJson: toStringOrNull(row.result_json),
    errorText: toStringOrNull(row.error_text),
    startedAt: Number(row.started_at),
    completedAt: toNumberOrNull(row.completed_at),
    durationMs: toNumberOrNull(row.duration_ms),
  });

const pickChartBucketMs = (windowMs: number): number => {
  if (windowMs <= 15 * 60_000) return 30_000; // <=15m → 30s
  if (windowMs <= 60 * 60_000) return 120_000; // <=1h → 2m
  if (windowMs <= 24 * 60 * 60_000) return 30 * 60_000; // <=24h → 30m
  if (windowMs <= 7 * 24 * 60 * 60_000) return 3 * 60 * 60_000; // <=7d → 3h
  return 24 * 60 * 60_000; // else → 1d
};

const matchesToolGlob = (toolPath: string, pattern: string): boolean => {
  if (pattern === toolPath) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return toolPath === prefix || toolPath.startsWith(`${prefix}.`);
  }
  return false;
};

export interface MakeExecutionStoreOptions {
  readonly core: TypedAdapter<CoreSchema>;
  readonly now?: () => Date;
}

export const makeExecutionStore = ({
  core,
  now = () => new Date(),
}: MakeExecutionStoreOptions): ExecutionStoreService => {
  const create: ExecutionStoreService["create"] = (input) =>
    Effect.gen(function* () {
      const timestamp = now();
      const row = yield* core.create({
        model: "execution",
        forceAllowId: true,
        data: {
          id: input.id,
          scope_id: input.scopeId,
          status: input.status,
          code: input.code,
          result_json: null,
          error_text: null,
          logs_json: null,
          started_at: input.startedAt ?? timestamp.getTime(),
          completed_at: null,
          trigger_kind: input.triggerKind ?? null,
          trigger_meta_json: input.triggerMetaJson ?? null,
          tool_call_count: 0,
          created_at: timestamp,
          updated_at: timestamp,
        },
      });
      return rowToExecution(row);
    });

  const update: ExecutionStoreService["update"] = (id, patch) =>
    Effect.gen(function* () {
      const row = yield* core.update({
        model: "execution",
        where: [{ field: "id", value: id as string }],
        update: {
          updated_at: now(),
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.resultJson !== undefined && { result_json: patch.resultJson }),
          ...(patch.errorText !== undefined && { error_text: patch.errorText }),
          ...(patch.logsJson !== undefined && { logs_json: patch.logsJson }),
          ...(patch.completedAt !== undefined && { completed_at: patch.completedAt }),
          ...(patch.toolCallCount !== undefined && {
            tool_call_count: patch.toolCallCount,
          }),
        },
      });
      if (!row) return yield* Effect.die(`Execution ${id} vanished during update`);
      return rowToExecution(row);
    });

  const get: ExecutionStoreService["get"] = (id) =>
    Effect.gen(function* () {
      const rows = yield* core.findMany({
        model: "execution",
        where: [{ field: "id", value: id as string }],
        limit: 1,
      });
      const execution = rows[0];
      if (!execution) return null;
      const interactions = yield* core.findMany({
        model: "execution_interaction",
        where: [
          { field: "execution_id", value: id as string },
          { field: "status", value: "pending" },
        ],
        sortBy: { field: "created_at", direction: "desc" },
        limit: 1,
      });
      const pendingInteraction = interactions[0]
        ? rowToInteraction(interactions[0])
        : null;
      return {
        execution: rowToExecution(execution),
        pendingInteraction,
      };
    });

  const recordInteraction: ExecutionStoreService["recordInteraction"] = (input) =>
    Effect.gen(function* () {
      const timestamp = now();
      const row = yield* core.create({
        model: "execution_interaction",
        forceAllowId: true,
        data: {
          id: input.id,
          execution_id: input.executionId,
          status: input.status,
          kind: input.kind,
          purpose: input.purpose ?? null,
          payload_json: input.payloadJson ?? null,
          response_json: null,
          response_private_json: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
      });
      return rowToInteraction(row);
    });

  const resolveInteraction: ExecutionStoreService["resolveInteraction"] = (id, patch) =>
    Effect.gen(function* () {
      const row = yield* core.update({
        model: "execution_interaction",
        where: [{ field: "id", value: id as string }],
        update: {
          updated_at: now(),
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.responseJson !== undefined && { response_json: patch.responseJson }),
          ...(patch.responsePrivateJson !== undefined && {
            response_private_json: patch.responsePrivateJson,
          }),
        },
      });
      if (!row)
        return yield* Effect.die(`Interaction ${id} vanished during update`);
      return rowToInteraction(row);
    });

  const recordToolCall: ExecutionStoreService["recordToolCall"] = (input) =>
    Effect.gen(function* () {
      const row = yield* core.create({
        model: "execution_tool_call",
        forceAllowId: true,
        data: {
          id: input.id,
          execution_id: input.executionId,
          status: "running",
          tool_path: input.toolPath,
          namespace: input.namespace ?? input.toolPath.split(".")[0] ?? null,
          args_json: input.argsJson ?? null,
          result_json: null,
          error_text: null,
          started_at: input.startedAt,
          completed_at: null,
          duration_ms: null,
        },
      });
      return rowToToolCall(row);
    });

  const finishToolCall: ExecutionStoreService["finishToolCall"] = (id, patch) =>
    Effect.gen(function* () {
      const row = yield* core.update({
        model: "execution_tool_call",
        where: [{ field: "id", value: id as string }],
        update: {
          status: patch.status,
          result_json: patch.resultJson ?? null,
          error_text: patch.errorText ?? null,
          completed_at: patch.completedAt,
          duration_ms: patch.durationMs,
        },
      });
      if (!row) return yield* Effect.die(`Tool call ${id} vanished during finish`);
      return rowToToolCall(row);
    });

  const listToolCalls: ExecutionStoreService["listToolCalls"] = (executionId) =>
    Effect.gen(function* () {
      const rows = yield* core.findMany({
        model: "execution_tool_call",
        where: [{ field: "execution_id", value: executionId as string }],
        sortBy: { field: "started_at", direction: "asc" },
      });
      return rows.map(rowToToolCall);
    });

  const sweep: ExecutionStoreService["sweep"] = (olderThanMs) =>
    Effect.gen(function* () {
      const cutoff = new Date(now().getTime() - olderThanMs);
      // Adapter deleteMany returns void in the generic contract — we do
      // a pre-count scan so the caller gets a useful number back.
      const doomed = yield* core.findMany({
        model: "execution",
        where: [{ field: "created_at", operator: "lt", value: cutoff }],
        limit: 10_000,
      });
      if (doomed.length === 0) return 0;
      yield* core.deleteMany({
        model: "execution",
        where: [{ field: "created_at", operator: "lt", value: cutoff }],
      });
      return doomed.length;
    });

  const list: ExecutionStoreService["list"] = (scopeId, rawOptions) =>
    Effect.gen(function* () {
      const options: ExecutionListOptions = rawOptions ?? {};
      const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const sort = options.sort ?? { field: "createdAt", direction: "desc" as const };

      // Pull candidate rows for this scope. We apply filters in-memory —
      // the DBAdapter contract's Where clauses don't cover compound
      // CSV-of-values or glob patterns, so the store does the final
      // narrowing after fetching.
      const rows = yield* core.findMany({
        model: "execution",
        where: [{ field: "scope_id", value: scopeId as string }],
        sortBy: {
          field: sort.field === "durationMs" ? "completed_at" : "created_at",
          direction: sort.direction,
        },
      });

      // Pre-compute tool-call aggregations that filters and meta both need.
      const toolCallRows = yield* core.findMany({
        model: "execution_tool_call",
      });

      const toolCallsByExecution = new Map<string, typeof toolCallRows[number][]>();
      for (const tc of toolCallRows) {
        const list = toolCallsByExecution.get(tc.execution_id as string) ?? [];
        list.push(tc);
        toolCallsByExecution.set(tc.execution_id as string, list);
      }

      // Pre-compute interaction presence per execution (for the
      // hadElicitation filter + meta interactionCounts).
      const interactionRows = yield* core.findMany({
        model: "execution_interaction",
      });
      const executionsWithInteractions = new Set(
        interactionRows.map((r) => r.execution_id as string),
      );

      const appliesStatusFilter = (row: AdapterRow): boolean =>
        !options.statusFilter || options.statusFilter.length === 0
          ? true
          : options.statusFilter.includes(row.status as ExecutionStatus);

      const appliesTriggerFilter = (row: AdapterRow): boolean => {
        if (!options.triggerFilter || options.triggerFilter.length === 0) return true;
        const kind = (row.trigger_kind as string | null | undefined) ?? null;
        return options.triggerFilter.some((want) =>
          want === "unknown" ? kind === null : want === kind,
        );
      };

      const appliesToolFilter = (row: AdapterRow): boolean => {
        if (!options.toolPathFilter || options.toolPathFilter.length === 0) return true;
        const calls = toolCallsByExecution.get(row.id as string) ?? [];
        return options.toolPathFilter.some((pattern) =>
          calls.some((c) => matchesToolGlob(c.tool_path as string, pattern)),
        );
      };

      const appliesTimeFilter = (row: AdapterRow): boolean => {
        const createdAt = toDate(row.created_at).getTime();
        if (options.timeRange?.from !== undefined && createdAt < options.timeRange.from) {
          return false;
        }
        if (options.timeRange?.to !== undefined && createdAt > options.timeRange.to) {
          return false;
        }
        if (options.after !== undefined) {
          const afterMs = Number(options.after);
          if (!Number.isNaN(afterMs) && createdAt <= afterMs) return false;
        }
        return true;
      };

      const appliesCodeQuery = (row: AdapterRow): boolean =>
        !options.codeQuery
          ? true
          : (row.code as string).toLowerCase().includes(options.codeQuery.toLowerCase());

      const appliesElicitationFilter = (row: AdapterRow): boolean => {
        if (options.hadElicitation === undefined) return true;
        const has = executionsWithInteractions.has(row.id as string);
        return options.hadElicitation ? has : !has;
      };

      const filtered = rows.filter(
        (row) =>
          appliesStatusFilter(row) &&
          appliesTriggerFilter(row) &&
          appliesToolFilter(row) &&
          appliesTimeFilter(row) &&
          appliesCodeQuery(row) &&
          appliesElicitationFilter(row),
      );

      // Cursor applies after filtering so it tracks the filtered scan.
      const cursor = options.cursor ? decodeCursor(options.cursor) : null;
      const afterCursor = cursor
        ? filtered.filter((row) => {
            const createdAt = toDate(row.created_at).getTime();
            if (createdAt < cursor.createdAt) return true;
            if (createdAt > cursor.createdAt) return false;
            return (row.id as string) < cursor.id;
          })
        : filtered;

      const page = afterCursor.slice(0, limit);
      const nextCursor =
        afterCursor.length > limit && sort.field === "createdAt"
          ? encodeCursor({
              createdAt: toDate(page[page.length - 1]!.created_at).getTime(),
              id: page[page.length - 1]!.id as string,
            })
          : undefined;

      const pageIds = page.map((r) => r.id as string);
      const pendingByExecution = new Map<string, AdapterRow>();
      for (const interaction of interactionRows) {
        if (interaction.status !== "pending") continue;
        if (!pageIds.includes(interaction.execution_id as string)) continue;
        const existing = pendingByExecution.get(interaction.execution_id as string);
        if (!existing || toDate(interaction.created_at).getTime() >
          toDate(existing.created_at).getTime()) {
          pendingByExecution.set(interaction.execution_id as string, interaction);
        }
      }

      const executions: readonly ExecutionListItem[] = page.map((row) => ({
        execution: rowToExecution(row),
        pendingInteraction: pendingByExecution.has(row.id as string)
          ? rowToInteraction(pendingByExecution.get(row.id as string)!)
          : null,
      }));

      const meta: ExecutionListMeta | undefined = options.includeMeta
        ? buildMeta(rows, filtered, toolCallsByExecution, executionsWithInteractions)
        : undefined;

      return {
        executions,
        ...(nextCursor ? { nextCursor } : {}),
        ...(meta ? { meta } : {}),
      } satisfies ExecutionListResult;
    });

  const buildMeta = (
    all: readonly AdapterRow[],
    filtered: readonly AdapterRow[],
    toolCallsByExecution: Map<string, AdapterRow[]>,
    executionsWithInteractions: Set<string>,
  ): ExecutionListMeta => {
    const statusCounts: ExecutionStatusCount[] = EXECUTION_STATUS_KEYS.map((status) => ({
      status,
      count: filtered.filter((r) => r.status === status).length,
    }));

    const triggerMap = new Map<string | null, number>();
    for (const row of filtered) {
      const kind = (row.trigger_kind as string | null | undefined) ?? null;
      triggerMap.set(kind, (triggerMap.get(kind) ?? 0) + 1);
    }
    const triggerCounts: ExecutionTriggerCount[] = Array.from(triggerMap.entries()).map(
      ([triggerKind, count]) => ({ triggerKind, count }),
    );

    const toolCountMap = new Map<string, number>();
    for (const row of filtered) {
      for (const tc of toolCallsByExecution.get(row.id as string) ?? []) {
        const path = tc.tool_path as string;
        toolCountMap.set(path, (toolCountMap.get(path) ?? 0) + 1);
      }
    }
    const toolFacets: ExecutionToolFacet[] = Array.from(toolCountMap.entries())
      .map(([toolPath, count]) => ({ toolPath, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const withElicitation = filtered.filter((r) =>
      executionsWithInteractions.has(r.id as string),
    ).length;

    const times = filtered.map((r) => toDate(r.created_at).getTime());
    const minTs = times.length > 0 ? Math.min(...times) : now().getTime();
    const maxTs = times.length > 0 ? Math.max(...times) : now().getTime();
    const windowMs = Math.max(1, maxTs - minTs);
    const chartBucketMs = pickChartBucketMs(windowMs);

    const bucketMap = new Map<number, Record<ExecutionStatus, number>>();
    for (const row of filtered) {
      const bucketStart =
        Math.floor(toDate(row.created_at).getTime() / chartBucketMs) * chartBucketMs;
      const counts = bucketMap.get(bucketStart) ?? {
        pending: 0,
        running: 0,
        waiting_for_interaction: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };
      counts[row.status as ExecutionStatus] += 1;
      bucketMap.set(bucketStart, counts);
    }
    const chartData: ExecutionChartBucket[] = Array.from(bucketMap.entries())
      .map(([bucketStart, counts]) => ({ bucketStart, counts }))
      .sort((a, b) => a.bucketStart - b.bucketStart);

    return {
      totalRowCount: all.length,
      filterRowCount: filtered.length,
      statusCounts,
      triggerCounts,
      toolFacets,
      interactionCounts: {
        withElicitation,
        withoutElicitation: filtered.length - withElicitation,
      },
      chartBucketMs,
      chartData,
    };
  };

  return {
    create,
    update,
    get,
    list,
    recordInteraction,
    resolveInteraction,
    recordToolCall,
    finishToolCall,
    listToolCalls,
    sweep,
  } satisfies ExecutionStoreService;
};

// Re-export the Tag symbol here so callers can `import { ExecutionStore }
// from "@executor/sdk"` and get both the Tag and a layer factory from
// one module entry.
export { ExecutionStore } from "./executions";
export type { StorageFailure };
