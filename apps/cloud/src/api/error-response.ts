import * as Sentry from "@sentry/cloudflare";
import { Cause, Data, Effect, Result } from "effect";
import {
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

// Implements `Respondable` so the framework's default cause→response
// pipeline (`HttpServerRespondable.toResponseOrElse`) renders this as the
// declared JSON body + status code without an explicit `catchCause` at
// every error boundary.
export class HttpResponseError extends Data.TaggedError("HttpResponseError")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {
  [HttpServerRespondable.symbol](): Effect.Effect<HttpServerResponse.HttpServerResponse> {
    if (this.status >= 500) Sentry.captureException(this);
    return Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        { error: this.message, code: this.code },
        { status: this.status },
      ),
    );
  }
}

const unwrapCause = (error: unknown): unknown => {
  if (!Cause.isCause(error)) return error;

  const failure = Cause.findError(error);
  if (Result.isSuccess(failure)) return failure.success;

  const defect = Cause.findDefect(error);
  if (Result.isSuccess(defect)) return defect.success;

  return error;
};

const toHttpResponseError = (error: unknown): HttpResponseError => {
  const unwrapped = unwrapCause(error);
  return unwrapped instanceof HttpResponseError
    ? unwrapped
    : new HttpResponseError({
        status: 500,
        code: "internal_server_error",
        message: "Internal server error",
      });
};

export const isServerError = (error: unknown): boolean => toHttpResponseError(error).status >= 500;

export const toErrorResponse = (error: unknown): Response => {
  const mapped = toHttpResponseError(error);
  if (mapped.status >= 500) Sentry.captureException(error);
  return Response.json({ error: mapped.message, code: mapped.code }, { status: mapped.status });
};

export const toErrorServerResponse = (error: unknown): HttpServerResponse.HttpServerResponse => {
  const mapped = toHttpResponseError(error);
  if (mapped.status >= 500) {
    console.error(
      "[api] toErrorServerResponse error:",
      error instanceof Error ? error.stack : error,
    );
    Sentry.captureException(error);
  }
  return HttpServerResponse.jsonUnsafe(
    { error: mapped.message, code: mapped.code },
    { status: mapped.status },
  );
};
