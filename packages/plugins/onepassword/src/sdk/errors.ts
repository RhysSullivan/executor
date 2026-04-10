import { Schema } from "effect";

export class OnePasswordError extends Schema.TaggedError<OnePasswordError>()("OnePasswordError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
