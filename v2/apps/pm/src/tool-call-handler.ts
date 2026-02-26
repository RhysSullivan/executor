import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
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

export type PmToolCallHttpHandlerService = {
  handleToolCallHttp: (request: Request) => Promise<Response>;
};

export class PmToolCallHttpHandler extends Context.Tag("@executor-v2/app-pm/PmToolCallHttpHandler")<
  PmToolCallHttpHandler,
  PmToolCallHttpHandlerService
>() {}

export const PmToolCallHttpHandlerLive = Layer.effect(
  PmToolCallHttpHandler,
  Effect.gen(function* () {
    const handler = yield* PmToolCallHandler;
    const runtime = yield* Effect.runtime<never>();
    const runPromise = Runtime.runPromise(runtime);

    const handleToolCallHttp = (request: Request): Promise<Response> =>
      runPromise(
        Effect.tryPromise({
          try: () => request.json(),
          catch: decodeRequestBodyError,
        }).pipe(
          Effect.flatMap((body) => decodeRuntimeToolCallRequest(body)),
          Effect.flatMap((input) => handler.handleToolCall(input)),
          Effect.map((result) => Response.json(result, { status: 200 })),
          Effect.catchAll((error) =>
            Effect.succeed(
              Response.json(
                {
                  ok: false,
                  kind: "failed",
                  error: errorToText(error),
                } satisfies RuntimeToolCallResult,
                { status: 400 },
              ),
            ),
          ),
        ),
      );

    return PmToolCallHttpHandler.of({
      handleToolCallHttp,
    });
  }),
);
