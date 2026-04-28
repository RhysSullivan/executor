import { Schema } from "effect";
import { HttpApiSchema } from "@effect/platform";

export class OnePasswordError extends Schema.TaggedError<OnePasswordError>()(
  "OnePasswordError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 502 }),
) {}
