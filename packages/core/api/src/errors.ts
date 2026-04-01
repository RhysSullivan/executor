import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

export class ApiNotFoundError extends Schema.TaggedError<ApiNotFoundError>()(
  "ApiNotFoundError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class ApiBadRequestError extends Schema.TaggedError<ApiBadRequestError>()(
  "ApiBadRequestError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class ApiInternalError extends Schema.TaggedError<ApiInternalError>()(
  "ApiInternalError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}
