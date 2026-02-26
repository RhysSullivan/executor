import { executeJavaScriptWithTools } from "@executor-v2/engine/local-runner";
import type {
  CanonicalToolDescriptor,
  ToolProviderRegistryService,
} from "@executor-v2/engine/tool-providers";
import type { Source } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

export type RuntimeRunnableTool = {
  descriptor: CanonicalToolDescriptor;
  source: Source | null;
};

export type RuntimeExecuteInput = {
  code: string;
  tools: ReadonlyArray<RuntimeRunnableTool>;
  timeoutMs?: number;
};

export type RuntimeAdapter = {
  kind: "local-inproc";
  isAvailable: () => Effect.Effect<boolean>;
  execute: (
    input: RuntimeExecuteInput,
  ) => Effect.Effect<unknown, unknown, ToolProviderRegistryService>;
};

export const makeLocalInProcessRuntimeAdapter = (): RuntimeAdapter => ({
  kind: "local-inproc",
  isAvailable: () => Effect.succeed(true),
  execute: (input) =>
    executeJavaScriptWithTools({
      code: input.code,
      tools: input.tools,
    }),
});
