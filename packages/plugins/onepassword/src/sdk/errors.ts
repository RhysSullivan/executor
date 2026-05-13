import { Schema } from "effect";

export class OnePasswordError extends Schema.TaggedErrorClass<OnePasswordError>()(
  "OnePasswordError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}
