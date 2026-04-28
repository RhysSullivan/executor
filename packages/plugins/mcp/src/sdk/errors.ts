// MCP plugin tagged errors. Each carries an `HttpApiSchema` annotation so
// it can be `.addError(...)` directly on the API group — handlers return
// these and HttpApi encodes them as 4xx responses with a typed body. No
// per-handler sanitisation step.

import { Schema } from "effect";
import { HttpApiSchema } from "@effect/platform";

export class McpConnectionError extends Schema.TaggedError<McpConnectionError>()(
  "McpConnectionError",
  {
    transport: Schema.String,
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class McpToolDiscoveryError extends Schema.TaggedError<McpToolDiscoveryError>()(
  "McpToolDiscoveryError",
  {
    stage: Schema.Literal("connect", "list_tools"),
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class McpInvocationError extends Schema.TaggedError<McpInvocationError>()(
  "McpInvocationError",
  {
    toolName: Schema.String,
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class McpOAuthError extends Schema.TaggedError<McpOAuthError>()(
  "McpOAuthError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}
