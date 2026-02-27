import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CredentialResolver,
  type CredentialResolverShape,
} from "./credential-resolver";
import {
  RuntimeToolInvoker,
  RuntimeToolInvokerError,
  type RuntimeToolInvokerShape,
} from "./runtime-tool-invoker";

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

const toResolverError = (message: string, details: string | null) =>
  new ToolInvocationServiceError({
    operation: "resolve_credentials",
    message,
    details,
  });

const toInvokerError = (cause: RuntimeToolInvokerError) =>
  new ToolInvocationServiceError({
    operation: "invoke_runtime_tool",
    message: cause.message,
    details: cause.details,
  });

export const makeToolInvocationService = (
  credentialResolver: CredentialResolverShape,
  runtimeToolInvoker: RuntimeToolInvokerShape,
): ToolInvocationServiceShape => ({
  invokeRuntimeToolCall: (input) =>
    Effect.gen(function* () {
      const credentials = yield* credentialResolver.resolveForToolCall(input).pipe(
        Effect.mapError((cause) => toResolverError(cause.message, cause.details)),
      );

      return yield* runtimeToolInvoker
        .invokeRuntimeToolCall({
          request: input,
          credentials,
        })
        .pipe(Effect.mapError(toInvokerError));
    }).pipe(
      Effect.catchTag("ToolInvocationServiceError", (error) =>
        Effect.succeed(toFailedResult(input, error)),
      ),
    ),
});

export const ToolInvocationServiceLive: Layer.Layer<
  ToolInvocationService,
  never,
  CredentialResolver | RuntimeToolInvoker
> = Layer.effect(
  ToolInvocationService,
  Effect.gen(function* () {
    const credentialResolver = yield* CredentialResolver;
    const runtimeToolInvoker = yield* RuntimeToolInvoker;

    return ToolInvocationService.of(
      makeToolInvocationService(credentialResolver, runtimeToolInvoker),
    );
  }),
);
