import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Source } from "@executor-v2/schema";

import type {
  CanonicalToolDescriptor,
  ToolProviderRegistryService,
} from "./tool-providers";

export type RuntimeAdapterKind = string;

export type RuntimeRunnableTool = {
  descriptor: CanonicalToolDescriptor;
  source: Source | null;
};

export type RuntimeExecuteInput = {
  code: string;
  tools: ReadonlyArray<RuntimeRunnableTool>;
  timeoutMs?: number;
};

export class RuntimeAdapterError extends Data.TaggedError("RuntimeAdapterError")<{
  operation: string;
  runtimeKind: RuntimeAdapterKind;
  message: string;
  details: string | null;
}> {}

export type RuntimeExecuteError = RuntimeAdapterError;

export interface RuntimeAdapter {
  readonly kind: RuntimeAdapterKind;
  readonly isAvailable: () => Effect.Effect<boolean>;
  readonly execute: (
    input: RuntimeExecuteInput,
  ) => Effect.Effect<unknown, RuntimeExecuteError, ToolProviderRegistryService>;
}

export class RuntimeAdapterRegistryError extends Data.TaggedError(
  "RuntimeAdapterRegistryError",
)<{
  operation: string;
  runtimeKind: RuntimeAdapterKind;
  message: string;
}> {}

export interface RuntimeAdapterRegistry {
  readonly register: (
    adapter: RuntimeAdapter,
  ) => Effect.Effect<void, RuntimeAdapterRegistryError>;

  readonly registerAll: (
    adapters: ReadonlyArray<RuntimeAdapter>,
  ) => Effect.Effect<void, RuntimeAdapterRegistryError>;

  readonly get: (
    runtimeKind: RuntimeAdapterKind,
  ) => Effect.Effect<RuntimeAdapter, RuntimeAdapterRegistryError>;

  readonly execute: (
    input: RuntimeExecuteInput & { runtimeKind: RuntimeAdapterKind },
  ) => Effect.Effect<unknown, RuntimeExecuteError | RuntimeAdapterRegistryError, ToolProviderRegistryService>;
}

export class RuntimeAdapterRegistryService extends Context.Tag(
  "@executor-v2/engine/RuntimeAdapterRegistryService",
)<RuntimeAdapterRegistryService, RuntimeAdapterRegistry>() {}

const duplicateRuntimeAdapterError = (
  runtimeKind: RuntimeAdapterKind,
): RuntimeAdapterRegistryError =>
  new RuntimeAdapterRegistryError({
    operation: "register",
    runtimeKind,
    message: `Runtime adapter already registered: ${runtimeKind}`,
  });

const runtimeAdapterNotFoundError = (
  operation: string,
  runtimeKind: RuntimeAdapterKind,
): RuntimeAdapterRegistryError =>
  new RuntimeAdapterRegistryError({
    operation,
    runtimeKind,
    message: `No runtime adapter registered for kind: ${runtimeKind}`,
  });

export const makeRuntimeAdapterRegistry = (
  initialAdapters: ReadonlyArray<RuntimeAdapter> = [],
): RuntimeAdapterRegistry => {
  const adaptersByKind = new Map<RuntimeAdapterKind, RuntimeAdapter>();

  const register = (
    adapter: RuntimeAdapter,
  ): Effect.Effect<void, RuntimeAdapterRegistryError> =>
    Effect.gen(function* () {
      if (adaptersByKind.has(adapter.kind)) {
        return yield* duplicateRuntimeAdapterError(adapter.kind);
      }

      adaptersByKind.set(adapter.kind, adapter);
    });

  const registerAll = (
    adapters: ReadonlyArray<RuntimeAdapter>,
  ): Effect.Effect<void, RuntimeAdapterRegistryError> =>
    Effect.forEach(adapters, register, { discard: true });

  const get = (
    runtimeKind: RuntimeAdapterKind,
  ): Effect.Effect<RuntimeAdapter, RuntimeAdapterRegistryError> =>
    Effect.gen(function* () {
      const adapter = adaptersByKind.get(runtimeKind);
      if (!adapter) {
        return yield* runtimeAdapterNotFoundError("get", runtimeKind);
      }

      return adapter;
    });

  const execute = (
    input: RuntimeExecuteInput & { runtimeKind: RuntimeAdapterKind },
  ): Effect.Effect<
    unknown,
    RuntimeExecuteError | RuntimeAdapterRegistryError,
    ToolProviderRegistryService
  > =>
    Effect.gen(function* () {
      const adapter = yield* get(input.runtimeKind);
      return yield* adapter.execute(input);
    });

  for (const adapter of initialAdapters) {
    if (!adaptersByKind.has(adapter.kind)) {
      adaptersByKind.set(adapter.kind, adapter);
    }
  }

  return {
    register,
    registerAll,
    get,
    execute,
  };
};

export const RuntimeAdapterRegistryLive = (
  initialAdapters: ReadonlyArray<RuntimeAdapter> = [],
): Layer.Layer<RuntimeAdapterRegistryService> =>
  Layer.succeed(RuntimeAdapterRegistryService, makeRuntimeAdapterRegistry(initialAdapters));
