import { Schema } from "effect";

/** A raw HTTP request issued by the http-source `request` tool failed at the
 *  transport layer (connection error, body read failure). Upstream non-2xx
 *  responses are NOT errors — they're returned as a shaped `HttpResponse`. */
export class HttpRequestError extends Schema.TaggedErrorClass<HttpRequestError>()(
  "HttpRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** The integration config stored on the row wasn't the expected http-source
 *  shape (missing `baseUrl` / `authenticationTemplate`). */
export class HttpConfigError extends Schema.TaggedErrorClass<HttpConfigError>()("HttpConfigError", {
  message: Schema.String,
}) {}
