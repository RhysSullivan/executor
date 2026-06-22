import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { Schema } from "effect";

import { ExecutorApi } from "../api";
import { formatExecuteResult, formatPausedExecution } from "@executor-js/execution";
import { ExecutionEngineService } from "../services";
import { capture, captureEngineError } from "@executor-js/api";

class ExecutionNotFoundError extends Schema.TaggedErrorClass<ExecutionNotFoundError>()(
  "ExecutionNotFoundError",
  {
    executionId: Schema.String,
  },
) {}

const parseOptionalNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toJsonCompatible = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonCompatible(item) ?? null);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isJsonRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonCompatible(item);
      if (converted !== undefined) {
        result[key] = converted;
      }
    }
    return result;
  }
  return undefined;
};

const jsonSafe = <A>(value: A): A => toJsonCompatible(value) as A;

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle("getPaused", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const paused = yield* captureEngineError(engine.getPausedExecution(path.executionId));

          if (!paused) {
            return yield* new ExecutionNotFoundError({ executionId: path.executionId });
          }

          return formatPausedExecution(paused);
        }),
      ),
    )
    .handle("execute", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const outcome = yield* captureEngineError(engine.executeWithPause(payload.code));

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
      ),
    )
    .handle("startCell", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          return yield* captureEngineError(
            engine.startCell(payload.code, {
              yieldAfterMs: payload.yieldAfterMs,
            }),
          ).pipe(Effect.map(jsonSafe));
        }),
      ),
    )
    .handle("waitCell", ({ params: path, query }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const result = yield* captureEngineError(
            engine.waitCell(path.cellId, {
              after: parseOptionalNumber(query.after),
              timeoutMs: parseOptionalNumber(query.timeoutMs),
            }),
          );

          if (!result) {
            return yield* new ExecutionNotFoundError({ executionId: path.cellId });
          }

          return jsonSafe(result);
        }),
      ),
    )
    .handle("terminateCell", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const result = yield* engine.terminateCell(path.cellId);

          if (!result) {
            return yield* new ExecutionNotFoundError({ executionId: path.cellId });
          }

          return jsonSafe(result);
        }),
      ),
    )
    .handle("resume", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const result = yield* captureEngineError(
            engine.resume(path.executionId, {
              action: payload.action,
              content: payload.content as Record<string, unknown> | undefined,
            }),
          );

          if (!result) {
            return yield* new ExecutionNotFoundError({ executionId: path.executionId });
          }

          if (result.status === "completed") {
            const formatted = formatExecuteResult(result.result);
            return {
              status: "completed" as const,
              text: formatted.text,
              structured: formatted.structured,
              isError: formatted.isError,
            };
          }

          const formatted = formatPausedExecution(result.execution);
          return {
            status: "paused" as const,
            text: formatted.text,
            structured: formatted.structured,
          };
        }),
      ),
    ),
);
