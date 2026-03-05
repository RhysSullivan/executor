import * as Effect from "effect/Effect";

import { makeToolInvokerFromTools } from "./tool-map";
import type {
  CodeExecutor,
  CodeToolOutput,
  OnElicitation,
  OnToolInteraction,
  ToolInvoker,
  ToolMap,
} from "./types";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const executeCodeWithTools = (input: {
  code: string;
  executor: CodeExecutor;
  tools?: ToolMap;
  sourceKey?: string;
  onToolInteraction?: OnToolInteraction;
  onElicitation?: OnElicitation;
  toolInvoker?: ToolInvoker;
}): Effect.Effect<CodeToolOutput, Error> =>
  Effect.gen(function* () {
    const toolInvoker = input.toolInvoker
      ?? (input.tools
        ? makeToolInvokerFromTools({
            tools: input.tools,
            sourceKey: input.sourceKey,
            onToolInteraction: input.onToolInteraction,
            onElicitation: input.onElicitation,
          })
        : null);

    if (!toolInvoker) {
      return yield* Effect.fail(
        new Error("executeCodeWithTools requires either tools or toolInvoker"),
      );
    }

    const result = yield* input.executor.execute(input.code, toolInvoker);
    if (result.error) {
      return yield* Effect.fail(new Error(result.error));
    }

    return {
      code: input.code,
      result: result.result,
      logs: result.logs,
    } satisfies CodeToolOutput;
  }).pipe(Effect.mapError(toError));
