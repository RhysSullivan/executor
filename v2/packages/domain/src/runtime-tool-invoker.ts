import type {
  RuntimeToolCallRequest,
  RuntimeToolCallResult,
} from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

export type RuntimeToolInvokerShape = {
  invokeRuntimeToolCall: (
    input: RuntimeToolInvokerInput,
  ) => Effect.Effect<RuntimeToolCallResult, RuntimeToolInvokerError>;
};

export class RuntimeToolInvoker extends Context.Tag(
  "@executor-v2/domain/RuntimeToolInvoker",
)<RuntimeToolInvoker, RuntimeToolInvokerShape>() {}

export const makeRuntimeToolInvoker = (
  invokeRuntimeToolCall: RuntimeToolInvokerShape["invokeRuntimeToolCall"],
): RuntimeToolInvokerShape => ({
  invokeRuntimeToolCall,
});

const makeUnimplementedRuntimeToolCallResult = (
  target: string,
  input: RuntimeToolInvokerInput,
): RuntimeToolCallResult => ({
  ok: false,
  kind: "failed",
  error: `${target} runtime callback received tool '${input.request.toolPath}', resolved ${Object.keys(input.credentials.headers).length} credential headers, but runtime tool invocation is not implemented`,
});

export const RuntimeToolInvokerUnimplementedLive = (
  target: string,
): Layer.Layer<RuntimeToolInvoker> =>
  Layer.succeed(
    RuntimeToolInvoker,
    RuntimeToolInvoker.of(
      makeRuntimeToolInvoker((input) =>
        Effect.succeed(makeUnimplementedRuntimeToolCallResult(target, input)),
      ),
    ),
  );
