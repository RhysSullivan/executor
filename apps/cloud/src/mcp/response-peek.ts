import * as Sentry from "@sentry/cloudflare";
import { Effect } from "effect";

import { jsonRpcWebResponse } from "./responses";

const SSE_PEEK_TIMEOUT_MS = 10_000;

type SandboxOutcome = {
  readonly status?: string;
  readonly error?: { readonly kind?: string; readonly message?: string };
};

type JsonRpcResponseBody = {
  readonly jsonrpc?: string;
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: SandboxOutcome;
  };
};

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
  try {
    if (contentType.includes("text/event-stream")) {
      for (const line of body.split(/\r?\n/)) {
        if (line.startsWith("data:")) return JSON.parse(line.slice(5).trimStart());
      }
      return null;
    }
    if (contentType.includes("application/json")) return JSON.parse(body);
    return null;
  } catch {
    return null;
  }
};

const jsonRpcResponseAttrs = (payload: JsonRpcResponseBody | null): Record<string, unknown> => {
  if (!payload || payload.jsonrpc !== "2.0") return {};
  const attrs: Record<string, unknown> = {};
  const err = payload.error;
  if (err && typeof err === "object") {
    attrs["mcp.rpc.is_error"] = true;
    if (typeof err.code === "number") attrs["mcp.rpc.error.code"] = err.code;
    if (typeof err.message === "string") {
      attrs["mcp.rpc.error.message"] = err.message.slice(0, 500);
    }
  }
  if (payload.result?.isError === true) attrs["mcp.tool.result.is_error"] = true;
  const structured = payload.result?.structuredContent;
  if (structured && typeof structured.status === "string") {
    attrs["mcp.tool.sandbox.status"] = structured.status;
    if (structured.error?.kind) attrs["mcp.tool.sandbox.error.kind"] = structured.error.kind;
    if (typeof structured.error?.message === "string") {
      attrs["mcp.tool.sandbox.error.message"] = structured.error.message.slice(0, 500);
    }
  }
  return attrs;
};

class ResponseBodyTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Timed out waiting for MCP response body after ${timeoutMs}ms`);
    this.name = "ResponseBodyTimeoutError";
  }
}

const readResponseText = async (response: Response, timeoutMs: number | null): Promise<string> => {
  if (timeoutMs === null) return await response.text();

  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new ResponseBodyTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const readPromise = (async () => {
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

const responseReadFailure = (error: unknown) =>
  Effect.gen(function* () {
    const timedOut = error instanceof ResponseBodyTimeoutError;
    yield* Effect.annotateCurrentSpan({
      "mcp.response.status_code": timedOut ? 504 : 500,
      "mcp.response.content_type": "application/json",
      "mcp.response.body.shape": "json-object",
      "mcp.response.body.length": 0,
      "mcp.response.jsonrpc.detected": true,
      "mcp.peek_response.timed_out": timedOut,
      "mcp.peek_response.error": String(error),
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
    const msg = payload.error.message ?? "unknown";
    Sentry.captureException(new Error(`MCP internal error (-32603): ${msg}`));
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
    const textResult = yield* Effect.tryPromise({
      try: () => readResponseText(response, timeoutMs),
      catch: (error) => error,
    }).pipe(
      Effect.withSpan("mcp.peek_response", {
        attributes: {
          "http.response.content_type": contentType,
          "http.response.status_code": response.status,
          "mcp.peek_response.timeout_ms": timeoutMs ?? 0,
        },
      }),
      Effect.either,
    );
    if (textResult._tag === "Left") return yield* responseReadFailure(textResult.left);

    const text = textResult.right;
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
