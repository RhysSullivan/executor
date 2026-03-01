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
  CredentialResolverError,
  type CredentialResolverShape,
} from "./credential-resolver";

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

const toResolverError = (cause: CredentialResolverError): ToolInvocationServiceError =>
  new ToolInvocationServiceError({
    operation: "resolve_credentials",
    message: cause.message,
    details: cause.details,
  });

const makeUnwiredRuntimeToolCallMessage = (
  target: string,
  input: RuntimeToolCallRequest,
  resolvedHeaderCount: number,
): RuntimeToolCallResult => ({
  ok: false,
  kind: "failed",
  error: `${target} runtime callback received tool '${input.toolPath}', resolved ${resolvedHeaderCount} credential headers, but tool invocation pipeline is not wired yet`,
});

export const makeToolInvocationService = (
  target: string,
  credentialResolver: CredentialResolverShape,
): ToolInvocationServiceShape => ({
  invokeRuntimeToolCall: (input) =>
    credentialResolver.resolveForToolCall(input).pipe(
      Effect.mapError(toResolverError),
      Effect.map((credentials) =>
        makeUnwiredRuntimeToolCallMessage(
          target,
          input,
          Object.keys(credentials.headers).length,
        ),
      ),
      Effect.catchTag("ToolInvocationServiceError", (error) =>
        Effect.succeed(toFailedResult(input, error)),
      ),
    ),
});

export const ToolInvocationServiceLive = (
  target: string,
): Layer.Layer<ToolInvocationService, never, CredentialResolver> =>
  Layer.effect(
    ToolInvocationService,
    Effect.gen(function* () {
      const credentialResolver = yield* CredentialResolver;

      return ToolInvocationService.of(
        makeToolInvocationService(target, credentialResolver),
      );
    }),
  );
