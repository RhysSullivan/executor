import * as Sentry from "@sentry/cloudflare";
import { Cause, Data, Effect, Exit, Option, Schema } from "effect";

import { jsonRpcWebResponse } from "./responses";

const SSE_PEEK_TIMEOUT_MS = 10_000;

class ResponseBodyTimeoutError extends Data.TaggedError("ResponseBodyTimeoutError")<{
  readonly timeoutMs: number;
}> {}

class ResponseBodyReadError extends Data.TaggedError("ResponseBodyReadError") {}

class McpInternalJsonRpcError extends Data.TaggedError("McpInternalJsonRpcError")<{
  readonly message: string;
}> {}

const ResponseBodyTimeoutErrorData = Schema.Struct({
  _tag: Schema.Literal("ResponseBodyTimeoutError"),
  timeoutMs: Schema.Number,
});
const decodeResponseBodyTimeoutError = Schema.decodeUnknownOption(ResponseBodyTimeoutErrorData);

const SandboxOutcomeSchema = Schema.Struct({
  status: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
});

const JsonRpcResponseBodySchema = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
  result: Schema.optional(
    Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.optional(SandboxOutcomeSchema),
    }),
  ),
});

const decodeJsonRpcResponseBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonRpcResponseBodySchema),
);

type JsonRpcResponseBody = typeof JsonRpcResponseBodySchema.Type;

const responseBodyShape = (body: string): string => {
  const trimmed = body.trimStart();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("{")) return "json-object";
  if (trimmed.startsWith("[")) return "json-array";
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) return "sse";
  if (trimmed.startsWith("<")) return "html-or-xml";
  return "other";
};

const parseFirstJsonRpc = (contentType: string, body: string): JsonRpcResponseBody | null => {
  if (!body) return null;
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        return Option.getOrNull(decodeJsonRpcResponseBody(line.slice(5).trimStart()));
      }
    }
    return null;
  }
  if (contentType.includes("application/json")) {
    return Option.getOrNull(decodeJsonRpcResponseBody(body));
  }
  return null;
};

const jsonRpcResponseAttrs = (payload: JsonRpcResponseBody | null): Record<string, unknown> => {
  if (!payload || payload.jsonrpc !== "2.0") return {};
  const attrs: Record<string, unknown> = {};
  const err = payload.error;
  if (err && typeof err === "object") {
    attrs["mcp.rpc.is_error"] = true;
    if (typeof err.code === "number") attrs["mcp.rpc.error.code"] = err.code;
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: schema-decoded JSON-RPC error message is protocol telemetry
    const { message } = err;
    if (typeof message === "string") {
      attrs["mcp.rpc.error.message"] = message.slice(0, 500);
    }
  }
  if (payload.result?.isError === true) attrs["mcp.tool.result.is_error"] = true;
  const structured = payload.result?.structuredContent;
  if (structured && typeof structured.status === "string") {
    attrs["mcp.tool.sandbox.status"] = structured.status;
    if (structured.error?.kind) attrs["mcp.tool.sandbox.error.kind"] = structured.error.kind;
    const message = structured.error?.["message"];
    if (typeof message === "string") {
      attrs["mcp.tool.sandbox.error.message"] = message.slice(0, 500);
    }
  }
  return attrs;
};

const readResponseText = async (response: Response, timeoutMs: number | null): Promise<string> => {
  if (timeoutMs === null) return await response.text();

  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      // oxlint-disable-next-line executor/no-promise-catch -- boundary: best-effort stream cancellation inside timeout callback
      void reader.cancel().catch(() => undefined);
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: Promise.race timeout adapter for Web ReadableStream
      reject(new ResponseBodyTimeoutError({ timeoutMs }));
    }, timeoutMs);
  });
  const readPromise = (async () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Web stream reader cleanup must clear host timeout after success or failure
    try {
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  })();

  return await Promise.race([readPromise, timeoutPromise]);
};

const annotateEmptyResponse = (response: Response, contentType: string) =>
  Effect.annotateCurrentSpan({
    "mcp.response.status_code": response.status,
    "mcp.response.content_type": contentType,
    "mcp.response.body.shape": "empty",
    "mcp.response.body.length": 0,
    "mcp.response.jsonrpc.detected": false,
  });

const withoutBodyHeaders = (response: Response) => {
  const headers = new Headers(response.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const isResponseBodyTimeoutError = (error: unknown) =>
  Option.isSome(decodeResponseBodyTimeoutError(error));

const responsePeekError = (error: unknown): ResponseBodyTimeoutError | ResponseBodyReadError =>
  Option.match(decodeResponseBodyTimeoutError(error), {
    onNone: () => new ResponseBodyReadError(),
    onSome: ({ timeoutMs }) => new ResponseBodyTimeoutError({ timeoutMs }),
  });

const responseReadFailure = (error: unknown) =>
  Effect.gen(function* () {
    const timedOut = isResponseBodyTimeoutError(error);
    yield* Effect.annotateCurrentSpan({
      "mcp.response.status_code": timedOut ? 504 : 500,
      "mcp.response.content_type": "application/json",
      "mcp.response.body.shape": "json-object",
      "mcp.response.body.length": 0,
      "mcp.response.jsonrpc.detected": true,
      "mcp.peek_response.timed_out": timedOut,
      "mcp.peek_response.error": timedOut ? "ResponseBodyTimeoutError" : "ResponseBodyReadError",
    });
    return jsonRpcWebResponse(
      timedOut ? 504 : 500,
      -32001,
      timedOut
        ? "Timed out waiting for MCP response - please retry"
        : "Failed to read MCP response",
    );
  });

const reportInternalJsonRpcError = (payload: JsonRpcResponseBody | null) =>
  Effect.sync(() => {
    if (payload?.error?.code !== -32603) return;
    const message = payload.error["message"] ?? "unknown";
    Sentry.captureException(new McpInternalJsonRpcError({ message }));
  });

export const peekAndAnnotate = (response: Response): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 202) {
      yield* annotateEmptyResponse(response, contentType);
      return withoutBodyHeaders(response);
    }
    if (!response.body) {
      yield* annotateEmptyResponse(response, contentType);
      return response;
    }

    const isSseResponse = contentType.includes("text/event-stream");
    const timeoutMs = isSseResponse ? SSE_PEEK_TIMEOUT_MS : null;
    const textExit = yield* Effect.exit(
      Effect.tryPromise({
        try: () => readResponseText(response, timeoutMs),
        catch: responsePeekError,
      }).pipe(
        Effect.withSpan("mcp.peek_response", {
          attributes: {
            "http.response.content_type": contentType,
            "http.response.status_code": response.status,
            "mcp.peek_response.timeout_ms": timeoutMs ?? 0,
          },
        }),
      ),
    );
    if (Exit.isFailure(textExit)) {
      const error = Option.getOrElse(
        Cause.findErrorOption(textExit.cause),
        () => new ResponseBodyReadError(),
      );
      return yield* responseReadFailure(error);
    }

    const text = textExit.value;
    const payload = parseFirstJsonRpc(contentType, text);
    yield* Effect.annotateCurrentSpan({
      "mcp.response.status_code": response.status,
      "mcp.response.content_type": contentType,
      "mcp.response.body.length": text.length,
      "mcp.response.body.shape": responseBodyShape(text),
      "mcp.response.jsonrpc.detected": payload?.jsonrpc === "2.0",
    });
    const attrs = jsonRpcResponseAttrs(payload);
    if (Object.keys(attrs).length > 0) yield* Effect.annotateCurrentSpan(attrs);
    yield* reportInternalJsonRpcError(payload);

    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
