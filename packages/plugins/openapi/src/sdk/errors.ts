import { Data, Schema } from "effect";
import type { Option } from "effect";

export class OpenApiParseError extends Schema.TaggedError<OpenApiParseError>()(
  "OpenApiParseError",
  {
    message: Schema.String,
  },
) {}

export class OpenApiExtractionError extends Schema.TaggedError<OpenApiExtractionError>()(
  "OpenApiExtractionError",
  {
    message: Schema.String,
  },
) {}

export class OpenApiInvocationError extends Data.TaggedError("OpenApiInvocationError")<{
  readonly message: string;
  readonly statusCode: Option.Option<number>;
  readonly cause?: unknown;
}> {}

export class OpenApiOAuthError extends Schema.TaggedError<OpenApiOAuthError>()(
  "OpenApiOAuthError",
  {
    message: Schema.String,
  },
) {}
