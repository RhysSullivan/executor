import { Schema } from "effect";

export class KeychainError extends Schema.TaggedError<KeychainError>()(
  "KeychainError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
