import { ToolInvocationService } from "@executor-v2/domain";
import type { RuntimeToolCallResult } from "@executor-v2/sdk";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

class PmToolCallHttpRequestError extends Data.TaggedError(
  "PmToolCallHttpRequestError",
)<{
  message: string;
  details: string | null;
}> {}

const RuntimeToolCallCredentialContextSchema = Schema.Struct({
  workspaceId: Schema.String,
  sourceKey: Schema.String,
  organizationId: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
});

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
  credentialContext: Schema.optional(RuntimeToolCallCredentialContextSchema),
});

const decodeRuntimeToolCallRequest = Schema.decodeUnknown(RuntimeToolCallRequestSchema);

const decodeRequestBodyError = (cause: unknown): PmToolCallHttpRequestError =>
  new PmToolCallHttpRequestError({
    message: "Invalid runtime callback request body",
    details: String(cause),
  });

const decodeRequestPayloadError = (cause: unknown): PmToolCallHttpRequestError =>
  new PmToolCallHttpRequestError({
    message: "Runtime callback request body is invalid",
    details: ParseResult.isParseError(cause)
      ? ParseResult.TreeFormatter.formatErrorSync(cause)
      : String(cause),
  });

const formatHttpRequestError = (error: PmToolCallHttpRequestError): string =>
  error.details && error.details.length > 0
    ? `${error.message}: ${error.details}`
    : error.message;

export const handleToolCallBody = Effect.fn(
  "@executor-v2/app-pm/tool-call.handle-body",
)(function* (body: unknown) {
  const toolInvocationService = yield* ToolInvocationService;
  const input = yield* decodeRuntimeToolCallRequest(body).pipe(
    Effect.mapError(decodeRequestPayloadError),
  );

  return yield* toolInvocationService.invokeRuntimeToolCall(input);
});

export const handleToolCallHttp = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(Schema.Unknown).pipe(
    Effect.mapError(decodeRequestBodyError),
  );
  const result = yield* handleToolCallBody(body);

  return yield* HttpServerResponse.json(result, { status: 200 });
}).pipe(
  Effect.catchTag("PmToolCallHttpRequestError", (error) =>
    HttpServerResponse.json(
      {
        ok: false,
        kind: "failed",
        error: formatHttpRequestError(error),
      } satisfies RuntimeToolCallResult,
      { status: 400 },
    ),
  ),
);
