import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { capture, captureEngineError } from "@executor/api";
import { ExecutionEngineService } from "@executor/api/server";
import { formatExecuteResult, formatPausedExecution } from "@executor/execution";

import { ProtectedCloudApi } from "../api";

// `/executions/...` — no scopeId path param. The engine is already
// bound to the request-scoped executor, which is pinned to the
// session's org at bootstrap.
export const ExecutionsHandlers = HttpApiBuilder.group(ProtectedCloudApi, "executions", (handlers) =>
  handlers
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
    .handle("resume", ({ path, payload }) =>
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
    ),
);
