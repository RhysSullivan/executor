import {
  ToolInvocationService,
  ToolInvocationServiceLive,
  type CredentialResolver,
} from "@executor-v2/domain";
import type { RuntimeToolCallResult } from "@executor-v2/sdk";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import { httpAction } from "./_generated/server";
import { ConvexCredentialResolverLive } from "./credential_resolver";

class RuntimeToolCallBadRequestError extends Data.TaggedError(
  "RuntimeToolCallBadRequestError",
)<{
  message: string;
  details: string;
}> {}

const RuntimeToolCallRequestSchema = Schema.Struct({
  runId: Schema.String,
  callId: Schema.String,
  toolPath: Schema.String,
  input: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
});

const decodeRuntimeToolCallRequest = Schema.decodeUnknown(RuntimeToolCallRequestSchema);

const toolInvocationLive: Layer.Layer<ToolInvocationService, never, CredentialResolver> =
  ToolInvocationServiceLive("convex");

const toolInvocationWithResolverLive = toolInvocationLive.pipe(
  Layer.provide(ConvexCredentialResolverLive),
);

const badRequest = (message: string): Response =>
  Response.json(
    {
      ok: false,
      kind: "failed",
      error: message,
    } satisfies RuntimeToolCallResult,
    { status: 400 },
  );

const formatBadRequestMessage = (error: RuntimeToolCallBadRequestError): string =>
  error.details.length > 0 ? `${error.message}: ${error.details}` : error.message;

const formatUnknownDetails = (cause: unknown): string => String(cause);

const handleToolCallHttpEffect = (
  request: Request,
): Effect.Effect<Response, never> =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: (cause) =>
        new RuntimeToolCallBadRequestError({
          message: "Invalid runtime callback request body",
          details: formatUnknownDetails(cause),
        }),
    });

    const input = yield* decodeRuntimeToolCallRequest(body).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeToolCallBadRequestError({
            message: "Runtime callback request body is invalid",
            details: ParseResult.TreeFormatter.formatErrorSync(cause),
          }),
      ),
    );

    const toolInvocationService = yield* ToolInvocationService;
    const result = yield* toolInvocationService.invokeRuntimeToolCall(input);

    return Response.json(result, { status: 200 });
  }).pipe(
    Effect.provide(toolInvocationWithResolverLive),
    Effect.catchTag("RuntimeToolCallBadRequestError", (error) =>
      Effect.succeed(badRequest(formatBadRequestMessage(error))),
    ),
  );

export const handleToolCallHttp = httpAction((_ctx, request) =>
  Effect.runPromise(handleToolCallHttpEffect(request)),
);
