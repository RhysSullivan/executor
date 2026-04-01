import { Schema } from "effect";

export class OpenApiParseError extends Schema.TaggedError<OpenApiParseError>()(
  "OpenApiParseError",
  {
    message: Schema.String,
    error: Schema.Defect,
  },
) {}

export class OpenApiExtractionError extends Schema.TaggedError<OpenApiExtractionError>()(
  "OpenApiExtractionError",
  {
    message: Schema.String,
  },
) {}

export class OpenApiInvocationError extends Schema.TaggedError<OpenApiInvocationError>()(
  "OpenApiInvocationError",
  {
    message: Schema.String,
    statusCode: Schema.optionalWith(Schema.Number, { as: "Option" }),
    error: Schema.Defect,
  },
) {}
