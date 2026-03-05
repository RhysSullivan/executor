import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ResolvedToolCredentials } from "./credential-resolver";

export class RuntimeToolInvokerError extends Data.TaggedError(
  "RuntimeToolInvokerError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export type RuntimeToolInvokerInput = {
  request: RuntimeToolCallRequest;
  credentials: ResolvedToolCredentials;
};

export type InvokeRuntimeToolCall = (
  input: RuntimeToolInvokerInput,
) => Effect.Effect<RuntimeToolCallResult, RuntimeToolInvokerError>;

const makeUnimplementedRuntimeToolCallResult = (
  target: string,
  input: RuntimeToolInvokerInput,
): RuntimeToolCallResult => ({
  ok: false,
  kind: "failed",
  error: `${target} runtime callback received tool '${input.request.toolPath}', resolved ${Object.keys(input.credentials.headers).length} credential headers, but runtime tool invocation is not implemented`,
});

export const createUnimplementedRuntimeToolInvoker = (
  target: string,
): InvokeRuntimeToolCall =>
  (input) => Effect.succeed(makeUnimplementedRuntimeToolCallResult(target, input));
