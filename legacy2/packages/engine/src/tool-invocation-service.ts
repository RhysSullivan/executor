import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type {
  CredentialResolverError,
  ResolveToolCredentials,
} from "./credential-resolver";
import {
  RuntimeToolInvokerError,
  type InvokeRuntimeToolCall,
} from "./runtime-tool-invoker";

export class ToolInvocationServiceError extends Data.TaggedError(
  "ToolInvocationServiceError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

type ToolInvocationDependencies = {
  resolveCredentials: ResolveToolCredentials;
  invokeRuntimeTool: InvokeRuntimeToolCall;
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

const toResolverError = (cause: CredentialResolverError) =>
  new ToolInvocationServiceError({
    operation: "resolve_credentials",
    message: cause.message,
    details: cause.details,
  });

const toInvokerError = (cause: RuntimeToolInvokerError) =>
  new ToolInvocationServiceError({
    operation: "invoke_runtime_tool",
    message: cause.message,
    details: cause.details,
  });

export const invokeRuntimeToolCall = (
  dependencies: ToolInvocationDependencies,
  request: RuntimeToolCallRequest,
): Effect.Effect<RuntimeToolCallResult, never> =>
  Effect.gen(function* () {
    const credentials = yield* dependencies.resolveCredentials(request).pipe(
      Effect.mapError(toResolverError),
    );

    return yield* dependencies
      .invokeRuntimeTool({
        request,
        credentials,
      })
      .pipe(Effect.mapError(toInvokerError));
  }).pipe(
    Effect.catchTag("ToolInvocationServiceError", (error) =>
      Effect.succeed(toFailedResult(request, error)),
    ),
  );

export const createRuntimeToolCallHandler = (
  dependencies: ToolInvocationDependencies,
): ((request: RuntimeToolCallRequest) => Effect.Effect<RuntimeToolCallResult, never>) => {
  return (request) => invokeRuntimeToolCall(dependencies, request);
};
