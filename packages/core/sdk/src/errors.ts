import { Schema } from "effect";

import { ToolId, SecretId, PolicyId } from "./ids";

export class ToolNotFoundError extends Schema.TaggedError<ToolNotFoundError>()(
  "ToolNotFoundError",
  { toolId: ToolId },
) {}

export class ToolInvocationError extends Schema.TaggedError<ToolInvocationError>()(
  "ToolInvocationError",
  {
    toolId: ToolId,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class SecretNotFoundError extends Schema.TaggedError<SecretNotFoundError>()(
  "SecretNotFoundError",
  { secretId: SecretId },
) {}

export class SecretResolutionError extends Schema.TaggedError<SecretResolutionError>()(
  "SecretResolutionError",
  {
    secretId: SecretId,
    message: Schema.String,
  },
) {}

export class PolicyDeniedError extends Schema.TaggedError<PolicyDeniedError>()(
  "PolicyDeniedError",
  {
    policyId: PolicyId,
    toolId: ToolId,
    reason: Schema.String,
  },
) {}
