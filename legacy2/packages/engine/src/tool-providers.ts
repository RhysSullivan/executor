import type {
  CanonicalToolDescriptor as SchemaCanonicalToolDescriptor,
  Source,
  ToolAvailability as SchemaToolAvailability,
  ToolDiscoveryResult as SchemaToolDiscoveryResult,
  ToolInvocationMode as SchemaToolInvocationMode,
  ToolInvokeResult,
  ToolProviderKind as SchemaToolProviderKind,
} from "@executor-v2/schema";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ToolAvailability = SchemaToolAvailability;
export type ToolInvocationMode = SchemaToolInvocationMode;
export type ToolProviderKind = SchemaToolProviderKind;
export type CanonicalToolDescriptor = SchemaCanonicalToolDescriptor;
export type ToolDiscoveryResult = SchemaToolDiscoveryResult;

export type InvokeToolInput = {
  source: Source | null;
  tool: CanonicalToolDescriptor;
  args: unknown;
  credentialHeaders?: Readonly<Record<string, string>>;
};

export type InvokeToolResult = ToolInvokeResult;

export class ToolProviderError extends Data.TaggedError("ToolProviderError")<{
  operation: string;
  providerKind: ToolProviderKind;
  message: string;
  details: string | null;
}> {}

export interface ToolProvider {
  readonly kind: ToolProviderKind;

  readonly discoverFromSource?: (
    source: Source,
  ) => Effect.Effect<ToolDiscoveryResult, ToolProviderError>;

  readonly invoke: (
    input: InvokeToolInput,
  ) => Effect.Effect<InvokeToolResult, ToolProviderError>;
}

export class ToolProviderRegistryError extends Data.TaggedError(
  "ToolProviderRegistryError",
)<{
  operation: string;
  providerKind: ToolProviderKind;
  message: string;
}> {}

export interface ToolProviderRegistry {
  readonly register: (
    provider: ToolProvider,
  ) => Effect.Effect<void, ToolProviderRegistryError>;

  readonly registerAll: (
    providers: ReadonlyArray<ToolProvider>,
  ) => Effect.Effect<void, ToolProviderRegistryError>;

  readonly get: (
    providerKind: ToolProviderKind,
  ) => Effect.Effect<ToolProvider, ToolProviderRegistryError>;

  readonly discoverFromSource: (
    source: Source,
  ) => Effect.Effect<ToolDiscoveryResult, ToolProviderRegistryError | ToolProviderError>;

  readonly invoke: (
    input: InvokeToolInput,
  ) => Effect.Effect<InvokeToolResult, ToolProviderRegistryError | ToolProviderError>;
}

export class ToolProviderRegistryService extends Context.Tag(
  "@executor-v2/engine/ToolProviderRegistryService",
)<ToolProviderRegistryService, ToolProviderRegistry>() {}

const duplicateProviderError = (
  providerKind: ToolProviderKind,
): ToolProviderRegistryError =>
  new ToolProviderRegistryError({
    operation: "register",
    providerKind,
    message: `Provider already registered: ${providerKind}`,
  });

const providerNotFoundError = (
  operation: string,
  providerKind: ToolProviderKind,
): ToolProviderRegistryError =>
  new ToolProviderRegistryError({
    operation,
    providerKind,
    message: `No provider registered for kind: ${providerKind}`,
  });

const providerDoesNotSupportDiscoveryError = (
  providerKind: ToolProviderKind,
): ToolProviderRegistryError =>
  new ToolProviderRegistryError({
    operation: "discoverFromSource",
    providerKind,
    message: `Provider does not support discovery: ${providerKind}`,
  });

export const makeToolProviderRegistry = (
  initialProviders: ReadonlyArray<ToolProvider> = [],
): ToolProviderRegistry => {
  const providersByKind = new Map<ToolProviderKind, ToolProvider>();

  const register = (
    provider: ToolProvider,
  ): Effect.Effect<void, ToolProviderRegistryError> =>
    Effect.gen(function* () {
      if (providersByKind.has(provider.kind)) {
        return yield* duplicateProviderError(provider.kind);
      }

      providersByKind.set(provider.kind, provider);
    });

  const registerAll = (
    providers: ReadonlyArray<ToolProvider>,
  ): Effect.Effect<void, ToolProviderRegistryError> =>
    Effect.forEach(providers, register, { discard: true });

  const get = (
    providerKind: ToolProviderKind,
  ): Effect.Effect<ToolProvider, ToolProviderRegistryError> =>
    Effect.gen(function* () {
      const provider = providersByKind.get(providerKind);
      if (!provider) {
        return yield* providerNotFoundError("get", providerKind);
      }

      return provider;
    });

  const discoverFromSource = (
    source: Source,
  ): Effect.Effect<ToolDiscoveryResult, ToolProviderRegistryError | ToolProviderError> =>
    Effect.gen(function* () {
      const provider = yield* get(source.kind);

      if (!provider.discoverFromSource) {
        return yield* providerDoesNotSupportDiscoveryError(provider.kind);
      }

      return yield* provider.discoverFromSource(source);
    });

  const invoke = (
    input: InvokeToolInput,
  ): Effect.Effect<InvokeToolResult, ToolProviderRegistryError | ToolProviderError> =>
    Effect.gen(function* () {
      const provider = yield* get(input.tool.providerKind);
      return yield* provider.invoke(input);
    });

  for (const provider of initialProviders) {
    if (!providersByKind.has(provider.kind)) {
      providersByKind.set(provider.kind, provider);
    }
  }

  return {
    register,
    registerAll,
    get,
    discoverFromSource,
    invoke,
  };
};

export const ToolProviderRegistryLive = (
  initialProviders: ReadonlyArray<ToolProvider> = [],
): Layer.Layer<ToolProviderRegistryService> =>
  Layer.succeed(ToolProviderRegistryService, makeToolProviderRegistry(initialProviders));
