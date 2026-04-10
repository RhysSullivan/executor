import { Data, Schema } from "effect";
import type { Option } from "effect";

export class GoogleDiscoveryParseError extends Data.TaggedError("GoogleDiscoveryParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
) {}

export class GoogleDiscoverySourceError extends Schema.TaggedError<GoogleDiscoverySourceError>()(
  "GoogleDiscoverySourceError",
  {
    message: Schema.String,
  },
) {}
