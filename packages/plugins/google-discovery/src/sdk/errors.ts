// Google Discovery plugin tagged errors. The three errors that cross
// the HTTP edge carry an `HttpApiSchema` annotation so they can be
// `.addError(...)` directly on the API group — handlers return them
// and HttpApi encodes each as a 4xx response with a typed body, no
// per-handler sanitisation step.
//
// `GoogleDiscoveryInvocationError` stays a `Data.TaggedError` because
// it only surfaces through `invokeTool`, which runs under the core
// `tools.invoke` endpoint — not any endpoint on the Google Discovery
// group — so it doesn't need an HTTP annotation.

import { Data, Schema } from "effect";
import { HttpApiSchema } from "@effect/platform";
import type { Option } from "effect";

export class GoogleDiscoveryParseError extends Schema.TaggedError<GoogleDiscoveryParseError>()(
  "GoogleDiscoveryParseError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class GoogleDiscoveryInvocationError extends Data.TaggedError(
  "GoogleDiscoveryInvocationError",
)<{
  readonly message: string;
  readonly statusCode: Option.Option<number>;
  readonly cause?: unknown;
}> {}

export class GoogleDiscoveryOAuthError extends Schema.TaggedError<GoogleDiscoveryOAuthError>()(
  "GoogleDiscoveryOAuthError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class GoogleDiscoverySourceError extends Schema.TaggedError<GoogleDiscoverySourceError>()(
  "GoogleDiscoverySourceError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}
