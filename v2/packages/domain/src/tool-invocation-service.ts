import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ToolInvocationServiceError extends Data.TaggedError(
  "ToolInvocationServiceError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export type ToolInvocationServiceShape = {
  invokeRuntimeToolCall: (
    input: RuntimeToolCallRequest,
  ) => Effect.Effect<RuntimeToolCallResult, never>;
};

export class ToolInvocationService extends Context.Tag(
  "@executor-v2/domain/ToolInvocationService",
)<ToolInvocationService, ToolInvocationServiceShape>() {}

export type ToolInvocationServiceLiveDependencies = {
  invokeRuntimeToolCall: (
    input: RuntimeToolCallRequest,
  ) => Effect.Effect<RuntimeToolCallResult, ToolInvocationServiceError>;
};

const toFailedResult = (
  input: RuntimeToolCallRequest,
  error: ToolInvocationServiceError,
): RuntimeToolCallResult => ({
  ok: false,
  kind: "failed",
  error: error.details
    ? `${error.message} (${error.details})`
    : `${error.message} [tool=${input.toolPath}]`,
});

export const makeToolInvocationService = (
  dependencies: ToolInvocationServiceLiveDependencies,
): ToolInvocationServiceShape => ({
  invokeRuntimeToolCall: (input) =>
    dependencies.invokeRuntimeToolCall(input).pipe(
      Effect.catchTag("ToolInvocationServiceError", (error) =>
        Effect.succeed(toFailedResult(input, error)),
      ),
    ),
});

export const ToolInvocationServiceUnwiredLive = (
  target: string,
): Layer.Layer<ToolInvocationService> =>
  Layer.succeed(
    ToolInvocationService,
    ToolInvocationService.of(
      makeToolInvocationService({
        invokeRuntimeToolCall: (input) =>
          Effect.fail(
            new ToolInvocationServiceError({
              operation: "invoke_runtime_tool_call",
              message: `${target} runtime callback received tool '${input.toolPath}', but tool invocation pipeline is not wired yet`,
              details: null,
            }),
          ),
      }),
    ),
  );
