import { Data, Schema } from "effect";
import { HttpApiSchema } from "@effect/platform";
import type { Option } from "effect";

// HTTP status lives on the class declaration so HttpApiBuilder's error
// encoder (which reads `ast.annotations` off the schema it stored on
// `group.addError(...)`) finds it. Applying the annotation post-hoc
// via `.annotations(...)` in group.ts produced a transform-wrapper AST
// whose status was not picked up — the error then slipped the typed
// channel and was captured as a 500 by the observability middleware,
// spamming Sentry on user misconfig.
export class OpenApiParseError extends Schema.TaggedError<OpenApiParseError>()(
  "OpenApiParseError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class OpenApiExtractionError extends Schema.TaggedError<OpenApiExtractionError>()(
  "OpenApiExtractionError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
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
  HttpApiSchema.annotations({ status: 400 }),
) {}
