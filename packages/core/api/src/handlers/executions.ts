import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { formatExecuteResult, formatPausedExecution } from "@executor/execution";
import {
  ExecutionId,
  type ExecutionSort,
  type ExecutionSortDirection,
  type ExecutionSortField,
  type ExecutionStatus,
} from "@executor/sdk";
import { ExecutionEngineService, ExecutorService } from "../services";

const EXECUTION_STATUSES = new Set<ExecutionStatus>([
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
]);

const SORT_FIELDS = new Set<ExecutionSortField>(["createdAt", "durationMs"]);
const SORT_DIRECTIONS = new Set<ExecutionSortDirection>(["asc", "desc"]);

/**
 * Parse a sort expression like `"createdAt,desc"` into an
 * `ExecutionSort` object. Returns `undefined` if the input is missing,
 * malformed, or references an unknown field/direction.
 */
const parseSortParam = (value: string | undefined): ExecutionSort | undefined => {
  if (!value) return undefined;
  const [rawField, rawDirection] = value.split(",");
  if (!rawField || !rawDirection) return undefined;
  if (!SORT_FIELDS.has(rawField as ExecutionSortField)) return undefined;
  if (!SORT_DIRECTIONS.has(rawDirection as ExecutionSortDirection)) return undefined;
  return {
    field: rawField as ExecutionSortField,
    direction: rawDirection as ExecutionSortDirection,
  };
};

/**
 * Parse the `elicitation` URL param into a tri-state boolean used by
 * the `hadElicitation` filter. `"true"` → `true`, `"false"` → `false`,
 * anything else (including `undefined`) → `undefined` (no filter).
 */
const parseElicitationParam = (value: string | undefined): boolean | undefined => {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle("list", ({ urlParams }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const statusFilter = urlParams.status
          ?.split(",")
          .map((value) => value.trim())
          .filter((value): value is ExecutionStatus => EXECUTION_STATUSES.has(value as ExecutionStatus));
        const triggerFilter = urlParams.trigger
          ?.split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        const toolPathFilter = urlParams.tool
          ?.split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        // Meta (chart + totals) is only computed on the first page so the
        // client can pin it without refetching on scroll. Live mode
        // refetches with ?after= and also skips meta — no chart rebucket.
        const includeMeta = urlParams.cursor === undefined && urlParams.after === undefined;
        const sort = parseSortParam(urlParams.sort);
        const hadElicitation = parseElicitationParam(urlParams.elicitation);
        const result = yield* executor.executions.list(executor.scope.id, {
          limit: Math.max(1, Math.min(urlParams.limit ?? 25, 100)),
          cursor: urlParams.cursor,
          statusFilter: statusFilter && statusFilter.length > 0 ? statusFilter : undefined,
          triggerFilter: triggerFilter && triggerFilter.length > 0 ? triggerFilter : undefined,
          toolPathFilter: toolPathFilter && toolPathFilter.length > 0 ? toolPathFilter : undefined,
          after: urlParams.after,
          timeRange:
            urlParams.from !== undefined || urlParams.to !== undefined
              ? {
                  from: urlParams.from,
                  to: urlParams.to,
                }
              : undefined,
          codeQuery: urlParams.code,
          sort,
          hadElicitation,
          includeMeta,
        });

        return {
          executions: result.executions,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          ...(result.meta ? { meta: result.meta } : {}),
        };
      }),
    )
    .handle("get", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const result = yield* executor.executions.get(ExecutionId.make(path.executionId));

        if (!result) {
          return yield* Effect.fail({
            _tag: "ExecutionNotFoundError" as const,
            executionId: path.executionId,
          });
        }

        return result;
      }),
    )
    .handle("listToolCalls", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        // Confirm the execution actually exists so we return 404 for
        // unknown ids rather than an empty success.
        const execution = yield* executor.executions.get(ExecutionId.make(path.executionId));
        if (!execution) {
          return yield* Effect.fail({
            _tag: "ExecutionNotFoundError" as const,
            executionId: path.executionId,
          });
        }
        const toolCalls = yield* executor.executions.listToolCalls(
          ExecutionId.make(path.executionId),
        );
        return { toolCalls };
      }),
    )
    .handle("execute", ({ payload, headers }) =>
      Effect.gen(function* () {
        const engine = yield* ExecutionEngineService;
        const triggerKind = headers["x-executor-trigger"] ?? "http";
        const outcome = yield* Effect.promise(() =>
          engine.executeWithPause(payload.code, {
            trigger: { kind: triggerKind },
          }),
        );

        if (outcome.status === "completed") {
          const formatted = formatExecuteResult(outcome.result);
          return {
            status: "completed" as const,
            text: formatted.text,
            structured: formatted.structured,
            isError: formatted.isError,
          };
        }

        const formatted = formatPausedExecution(outcome.execution);
        return {
          status: "paused" as const,
          text: formatted.text,
          structured: formatted.structured,
        };
      }),
    )
    .handle("resume", ({ path, payload }) =>
      Effect.gen(function* () {
        const engine = yield* ExecutionEngineService;
        const result = yield* Effect.promise(() =>
          engine.resume(ExecutionId.make(path.executionId), {
            action: payload.action,
            content: payload.content as Record<string, unknown> | undefined,
          }),
        );

        if (!result) {
          return yield* Effect.fail({
            _tag: "ExecutionNotFoundError" as const,
            executionId: path.executionId,
          });
        }

        if (result.status === "completed") {
          const formatted = formatExecuteResult(result.result);
          return {
            text: formatted.text,
            structured: formatted.structured,
            isError: formatted.isError,
          };
        }

        const formatted = formatPausedExecution(result.execution);
        return {
          text: formatted.text,
          structured: formatted.structured,
          isError: false,
        };
      }),
    ),
);
