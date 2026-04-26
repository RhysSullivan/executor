import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { formatExecuteResult, formatPausedExecution } from "@executor/execution";
import {
  EXECUTION_STATUS_KEYS,
  ExecutionId,
  type ExecutionSort,
  type ExecutionStatus,
} from "@executor/sdk";
import { ExecutionEngineService, ExecutorService } from "../services";
import { capture, captureEngineError } from "@executor/api";

// ---------------------------------------------------------------------------
// Query-string helpers
// ---------------------------------------------------------------------------

const STATUS_SET = new Set<string>(EXECUTION_STATUS_KEYS);
const SORT_FIELDS = new Set(["createdAt", "durationMs"] as const);
const SORT_DIRECTIONS = new Set(["asc", "desc"] as const);

const splitCsv = (value: string | undefined): string[] =>
  value
    ? value.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

const parseSortParam = (raw: string | undefined): ExecutionSort | undefined => {
  if (!raw) return undefined;
  const [rawField, rawDirection] = raw.split(",").map((s) => s.trim());
  if (!rawField || !rawDirection) return undefined;
  if (!SORT_FIELDS.has(rawField as (typeof SORT_FIELDS extends Set<infer T> ? T : never)))
    return undefined;
  if (!SORT_DIRECTIONS.has(rawDirection as "asc" | "desc")) return undefined;
  return {
    field: rawField as ExecutionSort["field"],
    direction: rawDirection as ExecutionSort["direction"],
  };
};

const parseElicitationParam = (raw: string | undefined): boolean | undefined => {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle("execute", ({ payload, headers }) =>
      capture(Effect.gen(function* () {
        const engine = yield* ExecutionEngineService;
        const triggerKind = headers["x-executor-trigger"] ?? "http";
        const outcome = yield* captureEngineError(
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
      })),
    )
    .handle("resume", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const engine = yield* ExecutionEngineService;
        const result = yield* captureEngineError(
          engine.resume(path.executionId, {
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
      })),
    )
    .handle("list", ({ urlParams }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        // Executions are scoped to the innermost scope of the current
        // executor stack — same rule the engine uses when writing the row.
        const scopeId = executor.scopes[0]!.id;

        const statusFilter = splitCsv(urlParams.status).filter(
          (v): v is ExecutionStatus => STATUS_SET.has(v),
        );
        const triggerFilter = splitCsv(urlParams.trigger);
        const toolPathFilter = splitCsv(urlParams.tool);
        const includeMeta =
          urlParams.cursor === undefined && urlParams.after === undefined;

        const result = yield* executor.executions.list(scopeId, {
          limit: urlParams.limit,
          cursor: urlParams.cursor,
          statusFilter: statusFilter.length > 0 ? statusFilter : undefined,
          triggerFilter: triggerFilter.length > 0 ? triggerFilter : undefined,
          toolPathFilter: toolPathFilter.length > 0 ? toolPathFilter : undefined,
          after: urlParams.after,
          timeRange:
            urlParams.from !== undefined || urlParams.to !== undefined
              ? { from: urlParams.from, to: urlParams.to }
              : undefined,
          codeQuery: urlParams.code,
          sort: parseSortParam(urlParams.sort),
          hadElicitation: parseElicitationParam(urlParams.elicitation),
          includeMeta,
        });

        return {
          executions: result.executions.map((item) => ({
            execution: {
              ...item.execution,
              createdAt: item.execution.createdAt.getTime(),
              updatedAt: item.execution.updatedAt.getTime(),
            },
            pendingInteraction: item.pendingInteraction
              ? {
                  ...item.pendingInteraction,
                  createdAt: item.pendingInteraction.createdAt.getTime(),
                  updatedAt: item.pendingInteraction.updatedAt.getTime(),
                }
              : null,
          })),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          ...(result.meta ? { meta: result.meta } : {}),
        };
      })),
    )
    .handle("get", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const detail = yield* executor.executions.get(
          ExecutionId.make(path.executionId),
        );
        if (!detail) {
          return yield* Effect.fail({
            _tag: "ExecutionNotFoundError" as const,
            executionId: path.executionId,
          });
        }
        return {
          execution: {
            ...detail.execution,
            createdAt: detail.execution.createdAt.getTime(),
            updatedAt: detail.execution.updatedAt.getTime(),
          },
          pendingInteraction: detail.pendingInteraction
            ? {
                ...detail.pendingInteraction,
                createdAt: detail.pendingInteraction.createdAt.getTime(),
                updatedAt: detail.pendingInteraction.updatedAt.getTime(),
              }
            : null,
        };
      })),
    )
    .handle("listToolCalls", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        // Guard so missing executions 404 instead of returning `[]`.
        const detail = yield* executor.executions.get(
          ExecutionId.make(path.executionId),
        );
        if (!detail) {
          return yield* Effect.fail({
            _tag: "ExecutionNotFoundError" as const,
            executionId: path.executionId,
          });
        }
        const toolCalls = yield* executor.executions.listToolCalls(
          ExecutionId.make(path.executionId),
        );
        return { toolCalls };
      })),
    ),
);
