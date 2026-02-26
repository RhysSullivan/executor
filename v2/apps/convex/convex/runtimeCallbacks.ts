import { createRpcFactory, makeRpcModule } from "@executor-v2/confect/rpc";
import { executorConfectSchema } from "@executor-v2/persistence-convex";
import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { unwrapRpcSuccess } from "./rpc_exit";

const runtimeToolCallResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  kind: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  approvalId: Schema.optional(Schema.String),
  retryAfterMs: Schema.optional(Schema.Number),
});

const factory = createRpcFactory({
  schema: executorConfectSchema,
});

export const handleToolCallImpl = (
  input: RuntimeToolCallRequest,
): Effect.Effect<RuntimeToolCallResult> =>
  Effect.succeed({
    ok: false,
    kind: "failed",
    error: `Convex runtime callback received tool '${input.toolPath}', but callback invocation is not wired yet.`,
  });

const handleToolCallEndpoint = factory.action({
  payload: {
    runId: Schema.String,
    callId: Schema.String,
    toolPath: Schema.String,
    input: Schema.optional(
      Schema.Record({
        key: Schema.String,
        value: Schema.Unknown,
      }),
    ),
  },
  success: runtimeToolCallResultSchema,
});

handleToolCallEndpoint.implement((payload) =>
  handleToolCallImpl({
    runId: payload.runId,
    callId: payload.callId,
    toolPath: payload.toolPath,
    input: payload.input,
  }),
);

const runtimeCallbacksRpc = makeRpcModule({
  handleToolCall: handleToolCallEndpoint,
});

export const handleToolCall = runtimeCallbacksRpc.handlers.handleToolCall;

const badRequest = (message: string): Response =>
  Response.json(
    {
      ok: false,
      kind: "failed",
      error: message,
    } satisfies RuntimeToolCallResult,
    { status: 400 },
  );

export const handleToolCallHttp = httpAction(async (ctx, request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    return badRequest(
      `Invalid runtime callback request body: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  if (typeof body !== "object" || body === null) {
    return badRequest("Runtime callback request body must be an object");
  }

  const payload = body as Partial<RuntimeToolCallRequest>;

  if (
    typeof payload.runId !== "string" ||
    typeof payload.callId !== "string" ||
    typeof payload.toolPath !== "string"
  ) {
    return badRequest("Runtime callback request body is missing required fields");
  }

  let result: RuntimeToolCallResult;
  try {
    result = unwrapRpcSuccess(
      await ctx.runAction(api.runtimeCallbacks.handleToolCall, {
        runId: payload.runId,
        callId: payload.callId,
        toolPath: payload.toolPath,
        input:
          payload.input && typeof payload.input === "object"
            ? (payload.input as Record<string, unknown>)
            : undefined,
      }),
      "runtimeCallbacks.handleToolCall",
    );
  } catch (cause) {
    return badRequest(cause instanceof Error ? cause.message : String(cause));
  }
  return Response.json(result, { status: 200 });
});
