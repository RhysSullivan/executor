import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "@executor/api";
import {
  formatExecuteResult,
  formatPausedExecution,
  type ExecutionEngine,
} from "@executor/execution";
import { ExecutionEngineService } from "../services/engine";

export const ExecutionsHandlers = HttpApiBuilder.group(
  ExecutorApi,
  "executions",
  (handlers) =>
    handlers
      .handle("execute", ({ payload }) =>
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const outcome = yield* Effect.promise(() =>
            engine.executeWithPause(payload.code),
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

          const formatted = formatExecuteResult(result);
          return {
            text: formatted.text,
            structured: formatted.structured,
            isError: formatted.isError,
          };
        }),
      ),
);
