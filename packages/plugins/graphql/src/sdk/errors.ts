import { Data, Schema } from "effect";
import type { Option } from "effect";

export class GraphqlIntrospectionError extends Schema.TaggedError<GraphqlIntrospectionError>()(
  "GraphqlIntrospectionError",
  {
    message: Schema.String,
  },
) {}

export class GraphqlExtractionError extends Schema.TaggedError<GraphqlExtractionError>()(
  "GraphqlExtractionError",
  {
    message: Schema.String,
  },
) {}

export class GraphqlInvocationError extends Data.TaggedError("GraphqlInvocationError")<{
  readonly message: string;
  readonly statusCode: Option.Option<number>;
  readonly cause?: unknown;
}> {}
