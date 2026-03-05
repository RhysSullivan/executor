import type { ExecuteRunInput, ExecuteRunResult } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import type { ExecuteRuntimeRun } from "./runtime-execution-port";

export type ExecuteRunOptions = {
  makeRunId?: () => string;
};

export const executeRun = (
  executeRuntimeRun: ExecuteRuntimeRun,
  input: ExecuteRunInput,
  options: ExecuteRunOptions = {},
): Effect.Effect<ExecuteRunResult> =>
  Effect.gen(function* () {
    const runId = input.runId?.trim().length
      ? input.runId.trim()
      : (options.makeRunId?.() ?? `run_${crypto.randomUUID()}`);

    const runtimeResult = yield* executeRuntimeRun({
      ...input,
      runId,
    }).pipe(Effect.either);
    if (Either.isLeft(runtimeResult)) {
      const error = runtimeResult.left;

      let interactionId: string | undefined;
      let waitingForInteraction = false;
      if (error.details) {
        try {
          const parsed = JSON.parse(error.details) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const runtimeOperation = (parsed as { runtimeOperation?: unknown }).runtimeOperation;
            const nestedDetails = (parsed as { details?: unknown }).details;
            if (runtimeOperation === "call_tool_pending" && typeof nestedDetails === "string") {
              const nestedParsed = JSON.parse(nestedDetails) as unknown;
              if (nestedParsed && typeof nestedParsed === "object" && !Array.isArray(nestedParsed)) {
                const candidate = (nestedParsed as { interactionId?: unknown }).interactionId;
                if (typeof candidate === "string" && candidate.trim().length > 0) {
                  interactionId = candidate;
                }
              }
              waitingForInteraction = interactionId !== undefined;
            }
          }
        } catch {
          waitingForInteraction = false;
        }
      }

      if (!waitingForInteraction) {
        const combinedErrorText = `${error.message}\n${error.details ?? ""}`;
        const interactionIdMatch = /interactionId=([A-Za-z0-9_-]+)/.exec(combinedErrorText);
        if (combinedErrorText.includes("requires interaction resolution")) {
          interactionId = interactionIdMatch?.[1];
          waitingForInteraction = true;
        }
      }

      if (waitingForInteraction && interactionId) {
        return {
          runId,
          status: "waiting_for_interaction",
          interactionId,
          error: error.message,
        } satisfies ExecuteRunResult;
      }

      return {
        runId,
        status: "failed",
        error: error.details ? `${error.message}: ${error.details}` : error.message,
      } satisfies ExecuteRunResult;
    }

    return {
      runId,
      status: "completed",
      result: runtimeResult.right,
    } satisfies ExecuteRunResult;
  });

export const createRunExecutor = (
  executeRuntimeRun: ExecuteRuntimeRun,
  options: ExecuteRunOptions = {},
): {
  executeRun: (input: ExecuteRunInput) => Effect.Effect<ExecuteRunResult>;
} => ({
  executeRun: (input) => executeRun(executeRuntimeRun, input, options),
});
