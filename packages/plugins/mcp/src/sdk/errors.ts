// MCP plugin tagged errors. Each carries an `HttpApiSchema` annotation so
// it can be `.addError(...)` directly on the API group — handlers return
// these and HttpApi encodes them as 4xx responses with a typed body. No
// per-handler sanitisation step.

import { Schema } from "effect";

export class McpConnectionError extends Schema.TaggedErrorClass<McpConnectionError>()(
  "McpConnectionError",
  {
    transport: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class McpToolDiscoveryError extends Schema.TaggedErrorClass<McpToolDiscoveryError>()(
  "McpToolDiscoveryError",
  {
    stage: Schema.Literals(["connect", "list_tools"]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class McpInvocationError extends Schema.TaggedErrorClass<McpInvocationError>()(
  "McpInvocationError",
  {
    toolName: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class McpOAuthError extends Schema.TaggedErrorClass<McpOAuthError>()(
  "McpOAuthError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
