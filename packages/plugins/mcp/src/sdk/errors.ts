import { Schema } from "effect";

export class McpConnectionError extends Schema.TaggedError<McpConnectionError>()(
  "McpConnectionError",
  {
    transport: Schema.String,
    message: Schema.String,
  },
) {}

export class McpToolDiscoveryError extends Schema.TaggedError<McpToolDiscoveryError>()(
  "McpToolDiscoveryError",
  {
    stage: Schema.Literal("connect", "list_tools"),
    message: Schema.String,
  },
) {}

export class McpInvocationError extends Schema.TaggedError<McpInvocationError>()(
  "McpInvocationError",
  {
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

export class McpOAuthError extends Schema.TaggedError<McpOAuthError>()("McpOAuthError", {
  message: Schema.String,
}) {}
