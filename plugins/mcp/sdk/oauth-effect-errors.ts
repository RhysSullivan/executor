import * as Data from "effect/Data";

export class McpOAuthEffectError extends Data.TaggedError(
  "McpOAuthEffectError",
)<{
  readonly module: string;
  readonly message: string;
}> {}

export const mcpOAuthEffectError = (
  module: string,
  message: string,
) => new McpOAuthEffectError({ module, message });
