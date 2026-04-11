import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { formatExecuteResult, formatPausedExecution } from "@executor/execution";
import { ExecutionId, type ExecutionStatus } from "@executor/sdk";
import { ExecutionEngineService, ExecutorService } from "../services";

const EXECUTION_STATUSES = new Set<ExecutionStatus>([
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
]);

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle("list", ({ urlParams }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const statusFilter = urlParams.status
          ?.split(",")
          .map((value) => value.trim())
          .filter((value): value is ExecutionStatus => EXECUTION_STATUSES.has(value as ExecutionStatus));
        // Meta (chart + totals) is only computed on the first page so the
        // client can pin it without refetching on scroll.
        const includeMeta = urlParams.cursor === undefined;
        const result = yield* executor.executions.list(executor.scope.id, {
          limit: Math.max(1, Math.min(urlParams.limit ?? 25, 100)),
          cursor: urlParams.cursor,
          statusFilter: statusFilter && statusFilter.length > 0 ? statusFilter : undefined,
          timeRange:
            urlParams.from !== undefined || urlParams.to !== undefined
              ? {
                  from: urlParams.from,
                  to: urlParams.to,
                }
              : undefined,
          codeQuery: urlParams.code,
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
    .handle("execute", ({ payload }) =>
      Effect.gen(function* () {
        const engine = yield* ExecutionEngineService;
        const outcome = yield* Effect.promise(() => engine.executeWithPause(payload.code));

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
