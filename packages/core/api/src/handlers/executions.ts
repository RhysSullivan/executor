import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { formatExecuteResult, formatPausedExecution } from "@executor/execution";
import { ExecutionEngineService } from "../services";
import { capture, captureEngineError } from "@executor/api";

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle("execute", ({ payload }) =>
      capture(Effect.gen(function* () {
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
    ),
);
