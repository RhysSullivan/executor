import { Data } from "effect";
import { HttpServerResponse } from "@effect/platform";

export class HttpResponseError extends Data.TaggedError("HttpResponseError")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {}

const toHttpResponseError = (error: unknown): HttpResponseError =>
  error instanceof HttpResponseError
    ? error
    : new HttpResponseError({
        status: 500,
        code: "internal_server_error",
        message: "Internal server error",
      });

export const isServerError = (error: unknown): boolean => toHttpResponseError(error).status >= 500;

export const toErrorResponse = (error: unknown): Response => {
  const mapped = toHttpResponseError(error);
  return Response.json({ error: mapped.message, code: mapped.code }, { status: mapped.status });
};

export const toErrorServerResponse = (error: unknown): HttpServerResponse.HttpServerResponse => {
  console.error("[api] toErrorServerResponse error:", error instanceof Error ? error.stack : error);
  const mapped = toHttpResponseError(error);
  return HttpServerResponse.unsafeJson(
    { error: mapped.message, code: mapped.code },
    { status: mapped.status },
  );
};
