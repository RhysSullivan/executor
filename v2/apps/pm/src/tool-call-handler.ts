import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export type PmToolCallHandlerService = {
  handleToolCall: (input: RuntimeToolCallRequest) => Effect.Effect<RuntimeToolCallResult>;
};

export class PmToolCallHandler extends Context.Tag("@executor-v2/app-pm/PmToolCallHandler")<
  PmToolCallHandler,
  PmToolCallHandlerService
>() {}

class PmToolCallHttpRequestError extends Data.TaggedError(
  "PmToolCallHttpRequestError",
)<{
  message: string;
  details: string | null;
}> {}

const RuntimeToolCallRequestSchema = Schema.Struct({
  runId: Schema.String,
  callId: Schema.String,
  toolPath: Schema.String,
  input: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  })),
});

const decodeRuntimeToolCallRequest = Schema.decodeUnknown(RuntimeToolCallRequestSchema);

const errorToText = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return String(error);
};

const decodeRequestBodyError = (cause: unknown): PmToolCallHttpRequestError =>
  new PmToolCallHttpRequestError({
    message: "Invalid runtime callback request body",
    details: cause instanceof Error ? cause.message : String(cause),
  });

const handleToolCall = Effect.fn("@executor-v2/app-pm/tool-call.handle")(function* (
  input: RuntimeToolCallRequest,
) {
  return {
    ok: false,
    kind: "failed",
    error: `PM runtime callback received tool '${input.toolPath}', but callback invocation is not wired yet.`,
  } satisfies RuntimeToolCallResult;
});

export const PmToolCallHandlerLive = Layer.succeed(
  PmToolCallHandler,
  PmToolCallHandler.of({
    handleToolCall,
  }),
);

export const handleToolCallBody = Effect.fn(
  "@executor-v2/app-pm/tool-call.handle-body",
)(function* (body: unknown) {
  const handler = yield* PmToolCallHandler;
  const input = yield* decodeRuntimeToolCallRequest(body).pipe(
    Effect.mapError(decodeRequestBodyError),
  );

  return yield* handler.handleToolCall(input);
});

export const handleToolCallHttp = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(Schema.Unknown);
  const result = yield* handleToolCallBody(body);

  return yield* HttpServerResponse.json(result, { status: 200 });
}).pipe(
  Effect.catchAll((error) =>
    HttpServerResponse.json(
      {
        ok: false,
        kind: "failed",
        error: errorToText(error),
      } satisfies RuntimeToolCallResult,
      { status: 400 },
    ),
  ),
);
